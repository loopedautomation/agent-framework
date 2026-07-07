// Plan 13: conversations are the unit of order. These tests drive
// AgentService.handle() with a hand-released provider so overlapping events
// are deterministic: within a conversation runs serialize in arrival order,
// across conversations they parallelize up to limits.concurrent_runs, and a
// full queue refuses immediately with an audit row.
import { assert, assertEquals } from "@std/assert";
import type { Completion, CompletionRequest, Provider } from "../providers/types.ts";
import { parseAgentConfig } from "../config/load.ts";
import { type AgentEvent, AgentService } from "./service.ts";

// Every complete() blocks until the test releases it, oldest first.
class GatedProvider implements Provider {
  id = "gated";
  calls: CompletionRequest[] = [];
  #pending: Array<(c: Completion) => void> = [];

  complete(req: CompletionRequest): Promise<Completion> {
    this.calls.push(req);
    return new Promise((resolve) => this.#pending.push(resolve));
  }

  release(content: string) {
    this.#pending.shift()!({
      content,
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  }
}

function makeConfig(limitsYaml = "") {
  return parseAgentConfig(`
handle: concurrency-bot
description: concurrency test agent
model:
  provider: openai-compatible
  id: test-model
purpose: You reply tersely.
memory:
  scope: thread
${limitsYaml}`);
}

async function makeService(limitsYaml = "") {
  const provider = new GatedProvider();
  const service = new AgentService({
    config: makeConfig(limitsYaml),
    provider,
    dataDir: await Deno.makeTempDir(),
  });
  // Pre-seed the name so the naming ritual doesn't consume a gated call.
  service.store.setIdentity("name", "Tester");
  return { service, provider };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

async function until(cond: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const event = (
  id: string,
  input: string,
  keys: Partial<Pick<AgentEvent, "conversationKey" | "serialKey">> = {},
): AgentEvent => ({ id, trigger: "test", input, ...keys });

Deno.test("service: overlapping events in one conversation serialize, and history keeps both runs", async () => {
  const { service, provider } = await makeService();
  const p1 = service.handle(event("1", "one", { conversationKey: "k" }));
  const p2 = service.handle(event("2", "two", { conversationKey: "k" }));

  await until(() => provider.calls.length === 1, "the first run to start");
  await tick();
  assertEquals(provider.calls.length, 1); // the second event waits its turn

  provider.release("first reply");
  await until(() => provider.calls.length === 2, "the second run to start");
  // The second run loaded history after the first persisted: it sees run one.
  assertEquals(
    provider.calls[1].messages.map((m) => m.content),
    ["one", "first reply", "two"],
  );
  provider.release("second reply");

  assertEquals((await p1).reply, "first reply");
  assertEquals((await p2).reply, "second reply");

  // The full transcript survived — the last-writer race would have erased run one.
  const messages = service.store.loadMessages(service.store.sessionFor("k"));
  assertEquals(messages.map((m) => m.content), ["one", "first reply", "two", "second reply"]);
  assertEquals(service.store.recentRuns().length, 2);
  await service.stop();
});

Deno.test("service: different conversations run in parallel", async () => {
  const { service, provider } = await makeService();
  const p1 = service.handle(event("1", "one", { conversationKey: "a" }));
  const p2 = service.handle(event("2", "two", { conversationKey: "b" }));
  // Both providers calls are in flight before either resolves.
  await until(() => provider.calls.length === 2, "both runs to start");
  provider.release("reply a");
  provider.release("reply b");
  assertEquals((await p1).status, "ok");
  assertEquals((await p2).status, "ok");
  await service.stop();
});

Deno.test("service: concurrent_runs 1 serializes the whole agent", async () => {
  const { service, provider } = await makeService("limits:\n  concurrent_runs: 1\n");
  const p1 = service.handle(event("1", "one", { conversationKey: "a" }));
  const p2 = service.handle(event("2", "two", { conversationKey: "b" }));
  await until(() => provider.calls.length === 1, "the first run to start");
  await tick();
  assertEquals(provider.calls.length, 1); // conversation b waits for the only slot
  provider.release("reply a");
  await until(() => provider.calls.length === 2, "the second run to start");
  provider.release("reply b");
  await Promise.all([p1, p2]);
  await service.stop();
});

Deno.test("service: an event past queue_depth is refused with a reply and an audit row", async () => {
  const { service, provider } = await makeService("limits:\n  queue_depth: 0\n");
  const p1 = service.handle(event("1", "one", { conversationKey: "k" }));
  await until(() => provider.calls.length === 1, "the first run to start");

  const refused = await service.handle(event("2", "two", { conversationKey: "k" }));
  assertEquals(refused.status, "rejected");
  assert(refused.reply.includes("queue is full"));
  assertEquals(refused.steps, 0);

  provider.release("first reply");
  assertEquals((await p1).status, "ok");

  // The refusal is an audit row, never a run.
  assertEquals(service.store.recentRuns().length, 1);
  const rows = service.store.recentAudit().filter((a) => a.kind === "queue");
  assertEquals(rows.length, 1);
  assert((rows[0].detail_json as string).includes('"eventId":"2"'));
  await service.stop();
});

Deno.test("service: a serial lane holds one running and one waiting, and skips the rest", async () => {
  const { service, provider } = await makeService();
  const fire = (id: string) => service.handle(event(id, "tick", { serialKey: "cron:job" }));

  const p1 = fire("1");
  await until(() => provider.calls.length === 1, "the first firing to start");
  const p2 = fire("2");
  await tick();
  assertEquals(provider.calls.length, 1); // second firing waits, third is refused

  const skipped = await fire("3");
  assertEquals(skipped.status, "rejected");
  assert(skipped.reply.includes("Skipped"));

  provider.release("first");
  await until(() => provider.calls.length === 2, "the waiting firing to start");
  provider.release("second");
  assertEquals((await p1).status, "ok");
  assertEquals((await p2).status, "ok");
  assertEquals(service.store.recentRuns().length, 2);
  await service.stop();
});
