// Plan 13: conversations are the unit of order. These tests drive
// AgentService.handle() with a hand-released provider so overlapping events
// are deterministic: within a conversation runs serialize in arrival order,
// across conversations they parallelize up to limits.concurrent_runs, and a
// full queue refuses immediately with an audit row.
import { assert, assertEquals } from "@std/assert";
import {
  type Completion,
  type CompletionRequest,
  type Provider,
  ProviderError,
} from "../providers/types.ts";
import { parseAgentConfig } from "../config/load.ts";
import { COMPACTION_MARKER, COMPACTION_PROMPT } from "../loop/compact.ts";
import type { RunEvent } from "../loop/loop.ts";
import { type AgentEvent, AgentService } from "./service.ts";

// Every complete() blocks until the test releases (or fails) it, oldest first.
class GatedProvider implements Provider {
  id = "gated";
  calls: CompletionRequest[] = [];
  #pending: Array<{ resolve: (c: Completion) => void; reject: (err: Error) => void }> = [];

  complete(req: CompletionRequest): Promise<Completion> {
    this.calls.push(req);
    return new Promise((resolve, reject) => this.#pending.push({ resolve, reject }));
  }

  release(content: string) {
    this.#pending.shift()!.resolve({
      content,
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  }

  releaseTool(name: string, args: unknown) {
    this.#pending.shift()!.resolve({
      content: "",
      toolCalls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }],
      stopReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  }

  fail(message: string) {
    this.#pending.shift()!.reject(new ProviderError(message, "overloaded"));
  }
}

function makeConfig(limitsYaml = "", memoryYaml = "memory:\n  scope: thread") {
  return parseAgentConfig(`
handle: concurrency-bot
description: concurrency test agent
model:
  provider: openai-compatible
  id: test-model
purpose: You reply tersely.
${memoryYaml}
${limitsYaml}`);
}

async function makeService(limitsYaml = "", memoryYaml?: string) {
  const provider = new GatedProvider();
  const service = new AgentService({
    config: makeConfig(limitsYaml, memoryYaml),
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

// --- Compaction (/compact and memory.compact_at_tokens) ---

/** Run `count` full exchanges through one conversation, releasing each. */
async function exchange(
  service: AgentService,
  provider: GatedProvider,
  count: number,
  key = "k",
) {
  for (let i = 1; i <= count; i++) {
    const p = service.handle(event(String(i), `msg ${i}`, { conversationKey: key }));
    await until(() => provider.calls.length >= i, `run ${i} to start`);
    provider.release(`reply ${i}`);
    await p;
  }
}

Deno.test("service: /compact folds older turns into a summary and keeps the recent ones", async () => {
  const { service, provider } = await makeService();
  await exchange(service, provider, 3);

  const p = service.handle(event("c", "/compact", { conversationKey: "k" }));
  await until(() => provider.calls.length === 4, "the summarize call");
  // The summarize call: the head plus the compaction prompt, no tools.
  const call = provider.calls[3];
  assertEquals(call.tools, undefined);
  assertEquals(call.messages.at(-1)?.content, COMPACTION_PROMPT);
  assertEquals(call.messages.map((m) => m.content).slice(0, 2), ["msg 1", "reply 1"]);
  provider.release("the summary");

  const result = await p;
  assertEquals(result.status, "ok");
  assertEquals(result.steps, 1);
  assertEquals(result.usage, { inputTokens: 10, outputTokens: 5 });
  assert(result.reply.includes("Compacted 6 messages"));

  const messages = service.store.loadMessages(service.store.sessionFor("k"));
  assertEquals(messages.map((m) => m.content), [
    COMPACTION_MARKER,
    "the summary",
    "msg 2",
    "reply 2",
    "msg 3",
    "reply 3",
  ]);
  await service.stop();
});

Deno.test("service: /compact emits a compaction event for the TUI's progress line", async () => {
  const { service, provider } = await makeService();
  await exchange(service, provider, 3);

  const events: RunEvent[] = [];
  const p = service.handle(event("c", "/compact", { conversationKey: "k" }), {
    onEvent: (e) => events.push(e),
  });
  await until(() => provider.calls.length === 4, "the summarize call");
  assertEquals(events, [{ type: "compaction", phase: "start", messageCount: 2 }]);
  provider.release("the summary");
  await p;
  await service.stop();
});

Deno.test("service: /compact declines politely when there is nothing to do", async () => {
  const { service, provider } = await makeService();

  const empty = await service.handle(event("c1", "/compact", { conversationKey: "k" }));
  assert(empty.reply.includes("no history to compact"));

  await exchange(service, provider, 2); // both turns fit the kept tail
  const nothingNew = await service.handle(event("c2", "/compact", { conversationKey: "k" }));
  assert(nothingNew.reply.includes("Nothing new to compact"));

  const sessionless = await service.handle(event("c3", "/compact"));
  assert(sessionless.reply.includes("keeps no conversation history"));

  assertEquals(provider.calls.length, 2); // only the exchanges reached the model
  await service.stop();
});

Deno.test("service: a failed /compact reports the error and leaves history alone", async () => {
  const { service, provider } = await makeService();
  await exchange(service, provider, 3);

  const p = service.handle(event("c", "/compact", { conversationKey: "k" }));
  await until(() => provider.calls.length === 4, "the summarize call");
  provider.fail("model went away");

  const result = await p;
  assertEquals(result.status, "error_provider");
  assert(result.reply.includes("History is unchanged"));
  assertEquals(service.store.loadMessages(service.store.sessionFor("k")).length, 6);
  await service.stop();
});

Deno.test("service: auto-compaction fires past the threshold, after the reply", async () => {
  // GatedProvider reports 10 input tokens per call; threshold 6 crosses on
  // every run, but the first two have nothing outside the kept tail.
  const { service, provider } = await makeService(
    "",
    "memory:\n  scope: thread\n  compact_at_tokens: 6",
  );
  await exchange(service, provider, 2);

  const p3 = service.handle(event("3", "msg 3", { conversationKey: "k" }));
  await until(() => provider.calls.length === 3, "run 3 to start");
  provider.release("reply 3");
  await until(() => provider.calls.length === 4, "the auto summarize call");
  provider.release("auto summary");

  const result = await p3;
  assertEquals(result.reply, "reply 3"); // the sender sees the run's reply, not the compaction

  const messages = service.store.loadMessages(service.store.sessionFor("k"));
  assertEquals(messages[0].content, COMPACTION_MARKER);
  assertEquals(messages[1].content, "auto summary");
  assertEquals(messages.length, 6);

  // The compaction is its own run row (the spend ledger) plus an audit row.
  const runs = service.store.recentRuns();
  assertEquals(runs.length, 4);
  assertEquals(runs[0].trigger, "compaction");
  assertEquals(runs[0].input_tokens, 10);
  const audit = service.store.recentAudit().filter((a) => a.kind === "compaction");
  assertEquals(audit.length, 1);
  await service.stop();
});

Deno.test("service: auto-compaction leaves a freshly compacted thread alone", async () => {
  const { service, provider } = await makeService(
    "",
    "memory:\n  scope: thread\n  compact_at_tokens: 6",
  );
  // Seed a thread that is already just a marker + summary pair.
  service.store.saveMessages(service.store.sessionFor("k"), [
    { role: "user", content: COMPACTION_MARKER },
    { role: "assistant", content: "old summary" },
  ]);

  const p = service.handle(event("1", "msg 1", { conversationKey: "k" }));
  await until(() => provider.calls.length === 1, "the run to start");
  provider.release("reply 1");
  await p;
  await tick();
  assertEquals(provider.calls.length, 1); // over threshold, but nothing outside the tail
  await service.stop();
});

Deno.test("service: compact_at_tokens false never auto-compacts", async () => {
  const { service, provider } = await makeService(
    "",
    "memory:\n  scope: thread\n  compact_at_tokens: false",
  );
  await exchange(service, provider, 4);
  await tick();
  assertEquals(provider.calls.length, 4); // one call per run, none for compaction
  await service.stop();
});

// --- Agent-created schedules (the schedule tools + ScheduleRunner) ---

/** A chat-shaped trigger that records deliveries for its keys. */
class FakeChatTrigger {
  readonly name = "fakechat";
  delivered: { key: string; text: string }[] = [];
  start(_emit: (event: AgentEvent) => Promise<unknown>): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  deliver(conversationKey: string, text: string): Promise<boolean> {
    if (!conversationKey.startsWith("fakechat:")) return Promise.resolve(false);
    this.delivered.push({ key: conversationKey, text });
    return Promise.resolve(true);
  }
}

Deno.test("service: a scheduled one-shot fires, runs, delivers, and retires", async () => {
  const { service, provider } = await makeService("schedules:\n  max: 5\n");
  const chat = new FakeChatTrigger();
  await service.start([chat]);

  // The model files a reminder ~150ms out, tied to this conversation.
  const p = service.handle(event("1", "remind me soon", { conversationKey: "fakechat:9" }));
  await until(() => provider.calls.length === 1, "the run to start");
  const at = new Date(Date.now() + 150).toISOString();
  provider.releaseTool("schedule", { prompt: "Reminder for Ratul: do the thing.", at });
  await until(() => provider.calls.length === 2, "the tool result round-trip");
  provider.release("Scheduled it.");
  assertEquals((await p).reply, "Scheduled it.");
  assertEquals(service.store.countSchedules(), 1);

  // The firing runs the scheduled prompt through the normal path...
  await until(() => provider.calls.length === 3, "the schedule to fire");
  assertEquals(provider.calls[2].messages.at(-1)?.content, "Reminder for Ratul: do the thing.");
  provider.release("Hey, do the thing!");

  // ...and the reply lands in the conversation that created it.
  await until(() => chat.delivered.length === 1, "delivery");
  assertEquals(chat.delivered[0], { key: "fakechat:9", text: "Hey, do the thing!" });
  await until(() => service.store.countSchedules() === 0, "the one-shot to retire");

  const runs = service.store.recentRuns();
  assertEquals(runs.length, 2);
  assertEquals(runs[0].trigger, "schedule");
  const audit = service.store.recentAudit().filter((a) => a.kind === "schedule");
  assertEquals(audit.length, 1);
  assert((audit[0].detail_json as string).includes('"action":"create"'));
  await service.stop();
});

Deno.test("service: unschedule disarms the live job and the row", async () => {
  const { service, provider } = await makeService("schedules:\n  max: 5\n");
  const p1 = service.handle(event("1", "schedule it", { conversationKey: "k" }));
  await until(() => provider.calls.length === 1, "run 1");
  provider.releaseTool("schedule", { prompt: "later", cron: "0 9 * * *" });
  await until(() => provider.calls.length === 2, "tool round-trip");
  provider.release("done");
  await p1;
  assertEquals(service.store.countSchedules(), 1);

  const p2 = service.handle(event("2", "cancel it", { conversationKey: "k" }));
  await until(() => provider.calls.length === 3, "run 2");
  provider.releaseTool("unschedule", { id: 1 });
  await until(() => provider.calls.length === 4, "tool round-trip 2");
  provider.release("cancelled");
  await p2;
  assertEquals(service.store.countSchedules(), 0);
  await service.stop();
});

Deno.test("service: persisted schedules survive a restart, and a missed one-shot fires late", async () => {
  const dataDir = await Deno.makeTempDir();
  // A previous life persisted two schedules, one of them already due.
  {
    const first = new AgentService({
      config: makeConfig("schedules:\n  max: 5\n"),
      provider: new GatedProvider(),
      dataDir,
    });
    first.store.setIdentity("name", "Tester");
    first.store.createSchedule({
      at: new Date(Date.now() - 60_000).toISOString(), // missed while down
      prompt: "overdue reminder",
    });
    first.store.createSchedule({
      at: new Date(Date.now() + 120).toISOString(),
      prompt: "upcoming reminder",
    });
    first.store.close();
  }

  const provider = new GatedProvider();
  const service = new AgentService({
    config: makeConfig("schedules:\n  max: 5\n"),
    provider,
    dataDir,
  });
  service.store.setIdentity("name", "Tester");
  await service.init(); // arms persisted schedules; fires the overdue one now

  await until(() => provider.calls.length >= 1, "the overdue one-shot to fire");
  provider.release("did the overdue thing");
  await until(() => provider.calls.length >= 2, "the upcoming one-shot to fire");
  provider.release("did the upcoming thing");
  await until(() => service.store.countSchedules() === 0, "both one-shots to retire");

  // runAgent mutates the request's array in place, so read the first
  // message (the scheduled prompt), which no later push can displace.
  const inputs = provider.calls.map((c) => c.messages[0]?.content);
  assert(inputs.includes("overdue reminder"));
  assert(inputs.includes("upcoming reminder"));
  await service.stop();
});
