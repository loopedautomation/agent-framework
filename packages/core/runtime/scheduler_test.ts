import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DrainingError, QueueFullError, RunScheduler } from "./scheduler.ts";

// A promise the test opens by hand — tasks block on it to hold a slot.
function gated() {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  return { open, release };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

Deno.test("scheduler: one lane runs serially, in arrival order", async () => {
  const s = new RunScheduler({ concurrentRuns: 4, queueDepth: 10 });
  const first = gated();
  const order: string[] = [];
  const p1 = s.submit("a", async () => {
    order.push("start-1");
    await first.open;
    order.push("end-1");
  });
  const p2 = s.submit("a", () => {
    order.push("start-2");
    return Promise.resolve();
  });
  const p3 = s.submit("a", () => {
    order.push("start-3");
    return Promise.resolve();
  });
  await tick();
  // Slots are free (cap 4), but the lane holds 2 and 3 behind 1.
  assertEquals(order, ["start-1"]);
  first.release();
  await Promise.all([p1, p2, p3]);
  assertEquals(order, ["start-1", "end-1", "start-2", "start-3"]);
});

Deno.test("scheduler: lanes run in parallel up to the cap", async () => {
  const s = new RunScheduler({ concurrentRuns: 2, queueDepth: 10 });
  const gates = [gated(), gated(), gated()];
  const started = [false, false, false];
  const runs = gates.map((g, i) =>
    s.submit(`lane-${i}`, async () => {
      started[i] = true;
      await g.open;
    })
  );
  await tick();
  // Two lanes hold the two slots; the third waits for one to free up.
  assertEquals(started, [true, true, false]);
  assertEquals(s.running, 2);
  assertEquals(s.queued, 1);
  gates[0].release();
  await tick();
  assert(started[2]);
  gates[1].release();
  gates[2].release();
  await Promise.all(runs);
  assertEquals(s.running, 0);
  assertEquals(s.queued, 0);
});

Deno.test("scheduler: a full lane refuses new events and recovers once drained", async () => {
  const s = new RunScheduler({ concurrentRuns: 1, queueDepth: 1 });
  const first = gated();
  const p1 = s.submit("a", () => first.open);
  const p2 = s.submit("a", () => Promise.resolve("second"));
  await tick();
  // One running, one waiting — the lane is full.
  assertThrows(() => s.submit("a", () => Promise.resolve()), QueueFullError);
  first.release();
  assertEquals(await p2, "second");
  await p1;
  // Drained: the lane accepts again.
  assertEquals(await s.submit("a", () => Promise.resolve("third")), "third");
});

Deno.test("scheduler: per-submit depth override holds a serial lane at one waiting", async () => {
  const s = new RunScheduler({ concurrentRuns: 4, queueDepth: 10 });
  const first = gated();
  const p1 = s.submit("cron:x", () => first.open, { queueDepth: 1 });
  const p2 = s.submit("cron:x", () => Promise.resolve(), { queueDepth: 1 });
  await tick();
  assertThrows(
    () => s.submit("cron:x", () => Promise.resolve(), { queueDepth: 1 }),
    QueueFullError,
  );
  first.release();
  await Promise.all([p1, p2]);
});

Deno.test("scheduler: keyless events take a slot directly, with no queue bound", async () => {
  const s = new RunScheduler({ concurrentRuns: 1, queueDepth: 0 });
  const first = gated();
  let ranSecond = false;
  const p1 = s.submit(undefined, () => first.open);
  const p2 = s.submit(undefined, () => {
    ranSecond = true;
    return Promise.resolve();
  });
  await tick();
  assert(!ranSecond); // waiting on the slot, never refused
  first.release();
  await Promise.all([p1, p2]);
  assert(ranSecond);
});

Deno.test("scheduler: a failing task rejects its own promise and the lane moves on", async () => {
  const s = new RunScheduler({ concurrentRuns: 2, queueDepth: 10 });
  const boom = s.submit("a", () => Promise.reject(new Error("boom")));
  const after = s.submit("a", () => Promise.resolve("after"));
  await assertRejects(() => boom, Error, "boom");
  assertEquals(await after, "after");
  assertEquals(s.running, 0);
});

Deno.test("drain lets accepted work finish and refuses anything new", async () => {
  const scheduler = new RunScheduler({ concurrentRuns: 2, queueDepth: 5 });
  const release: Array<() => void> = [];
  const blocked = () => new Promise<string>((r) => release.push(() => r("done")));

  const first = scheduler.submit("a", blocked);
  const second = scheduler.submit("b", blocked);
  assertEquals(scheduler.draining, false);
  // A lane task starts on a microtask, so let both reach the slot first.
  await new Promise((r) => setTimeout(r, 5));

  const drained = scheduler.drain();
  assertEquals(scheduler.draining, true);

  // Work accepted before the drain still runs.
  assertEquals(scheduler.running, 2);
  // Anything after it is refused rather than queued behind the shutdown.
  assertThrows(() => scheduler.submit("c", blocked), DrainingError);
  assertThrows(() => scheduler.submit(undefined, blocked), DrainingError);

  release[0]();
  release[1]();
  assertEquals(await first, "done");
  assertEquals(await second, "done");
  await drained;
  assertEquals(scheduler.running, 0);
});

Deno.test("draining an idle scheduler resolves immediately", async () => {
  const scheduler = new RunScheduler({ concurrentRuns: 2, queueDepth: 5 });
  await scheduler.drain();
  assertEquals(scheduler.draining, true);
});

Deno.test("drain waits for work that is queued behind a lane, not just running", async () => {
  const scheduler = new RunScheduler({ concurrentRuns: 1, queueDepth: 5 });
  const release: Array<() => void> = [];
  const blocked = () => new Promise<void>((r) => release.push(() => r()));

  const first = scheduler.submit("lane", blocked);
  const second = scheduler.submit("lane", blocked); // waiting behind the first
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(scheduler.running, 1);
  assertEquals(scheduler.queued, 1);

  let settled = false;
  const drained = scheduler.drain().then(() => (settled = true));

  release[0]();
  await first;
  await new Promise((r) => setTimeout(r, 5));
  // The second was accepted before the drain, so the drain is not done yet.
  assertEquals(settled, false);

  release[1]();
  await second;
  await drained;
  assertEquals(settled, true);
});
