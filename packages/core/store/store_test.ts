import { assert, assertEquals } from "@std/assert";
import { Store } from "./store.ts";

function tempStore(): Store {
  return new Store(":memory:");
}

Deno.test("sessions are stable per conversation key", () => {
  const store = tempStore();
  const a = store.sessionFor("discord:thread:123");
  const b = store.sessionFor("discord:thread:123");
  const c = store.sessionFor("discord:thread:456");
  assertEquals(a, b);
  assert(a !== c);
  store.close();
});

Deno.test("messages round-trip through a session", () => {
  const store = tempStore();
  const session = store.sessionFor("k");
  store.saveMessages(session, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello", toolCalls: [{ id: "t1", name: "x", arguments: "{}" }] },
  ]);
  const loaded = store.loadMessages(session);
  assertEquals(loaded.length, 2);
  assertEquals(loaded[1].role, "assistant");
  store.saveMessages(session, [{ role: "user", content: "replaced" }]);
  assertEquals(store.loadMessages(session).length, 1);
  store.close();
});

Deno.test("runs and audit records land in the trail", () => {
  const store = tempStore();
  const runId = store.recordRun({
    trigger: "webhook",
    input: "create an issue",
    status: "ok",
    reply: "done",
    steps: 2,
    usage: { inputTokens: 100, outputTokens: 20 },
    startedAt: new Date().toISOString(),
  });
  store.recordAudit({
    runId,
    kind: "permission",
    detail: { allowed: false, kind: "net", subject: "evil.com" },
  });

  const runs = store.recentRuns();
  assertEquals(runs.length, 1);
  assertEquals(runs[0].status, "ok");
  const audit = store.recentAudit();
  assertEquals(audit.length, 1);
  assert((audit[0].detail_json as string).includes("evil.com"));
  store.close();
});

Deno.test("identity persists (the agent's self-chosen name lives here)", () => {
  const store = tempStore();
  assertEquals(store.getIdentity("name"), undefined);
  store.setIdentity("name", "Ada");
  assertEquals(store.getIdentity("name"), "Ada");
  store.setIdentity("name", "Ada II");
  assertEquals(store.getIdentity("name"), "Ada II");
  store.close();
});

Deno.test("memories persist across keys, independent of session history", () => {
  const store = tempStore();
  assertEquals(store.recallMemory("favorite_color"), undefined);
  store.rememberMemory("favorite_color", "blue");
  assertEquals(store.recallMemory("favorite_color")?.value, "blue");
  store.rememberMemory("favorite_color", "green");
  assertEquals(store.recallMemory("favorite_color")?.value, "green");
  store.rememberMemory("timezone", "UTC");
  assertEquals(store.listMemories().length, 2);
  assert(store.forgetMemory("timezone"));
  assertEquals(store.forgetMemory("timezone"), false);
  assertEquals(store.listMemories().length, 1);
  store.close();
});

Deno.test("clearSession wipes one conversation's messages and nothing else", () => {
  const store = tempStore();
  const a = store.sessionFor("discord:a");
  const b = store.sessionFor("discord:b");
  store.saveMessages(a, [{ role: "user", content: "hi" }]);
  store.saveMessages(b, [{ role: "user", content: "yo" }]);
  store.rememberMemory("fact", "survives");

  assert(store.clearSession("discord:a"));
  assertEquals(store.loadMessages(a), []);
  assertEquals(store.loadMessages(b).length, 1);
  assertEquals(store.recallMemory("fact")?.value, "survives");

  assertEquals(store.clearSession("discord:a"), false); // already empty
  assertEquals(store.clearSession("no-such-key"), false);
  store.close();
});

Deno.test("archiveSession retires the thread and the key mints a fresh one", () => {
  const store = tempStore();
  const first = store.sessionFor("discord:chan");
  store.saveMessages(first, [{ role: "user", content: "hi" }]);

  assert(store.archiveSession("discord:chan"));
  const second = store.sessionFor("discord:chan");
  assert(first !== second);
  assertEquals(store.loadMessages(second), []);
  // The archived transcript is still there under the old id.
  assertEquals(store.loadMessages(first).length, 1);
  store.close();
});

Deno.test("archiveSession is honest about having nothing to archive", () => {
  const store = tempStore();
  assertEquals(store.archiveSession("no-such-key"), false);
  const empty = store.sessionFor("fresh");
  assertEquals(store.archiveSession("fresh"), false); // session exists, no messages
  assertEquals(store.sessionFor("fresh"), empty); // and stays the active one
  store.close();
});

Deno.test("clearSession leaves archived transcripts alone", () => {
  const store = tempStore();
  const old = store.sessionFor("k");
  store.saveMessages(old, [{ role: "user", content: "history" }]);
  store.archiveSession("k");

  assertEquals(store.clearSession("k"), false); // the fresh session is empty
  assertEquals(store.loadMessages(old).length, 1);
  store.close();
});

Deno.test("schedules round-trip: create, list, count, delete", () => {
  const store = tempStore();
  assertEquals(store.countSchedules(), 0);
  const daily = store.createSchedule({
    cron: "0 9 * * *",
    timezone: "Africa/Johannesburg",
    prompt: "post the standup",
    conversationKey: "discord:123",
  });
  const once = store.createSchedule({ at: "2027-01-05T09:00:00Z", prompt: "remind: renew domain" });
  assertEquals(store.countSchedules(), 2);

  const listed = store.listSchedules();
  assertEquals(listed.map((s) => s.id), [daily, once]);
  assertEquals(listed[0].cron, "0 9 * * *");
  assertEquals(listed[0].timezone, "Africa/Johannesburg");
  assertEquals(listed[0].conversationKey, "discord:123");
  assertEquals(listed[1].at, "2027-01-05T09:00:00Z");
  assertEquals(listed[1].cron, undefined);
  assertEquals(listed[1].conversationKey, undefined);

  assert(store.deleteSchedule(once));
  assertEquals(store.deleteSchedule(once), false); // already gone
  assertEquals(store.countSchedules(), 1);
  store.close();
});

Deno.test("runStats aggregates run count and token totals", () => {
  const store = tempStore();
  assertEquals(store.runStats(), {
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    pricedRuns: 0,
  });
  const run = {
    trigger: "cli",
    input: "hi",
    status: "ok" as const,
    reply: "hello",
    steps: 1,
    startedAt: new Date().toISOString(),
  };
  store.recordRun({ ...run, usage: { inputTokens: 10, outputTokens: 5 } });
  store.recordRun({ ...run, usage: { inputTokens: 7, outputTokens: 3 } });
  assertEquals(store.runStats(), {
    runs: 2,
    inputTokens: 17,
    outputTokens: 8,
    cost: 0,
    pricedRuns: 0,
  });
  store.close();
});

Deno.test("an open run stays open until it is closed", () => {
  const store = tempStore();
  const runId = store.openRun({
    trigger: "cron",
    input: "nightly sweep",
    startedAt: "2026-08-01T00:00:00.000Z",
  });

  const open = store.recentRuns()[0];
  assertEquals(open.status, "running");
  assertEquals(open.finished_at, null);
  assertEquals(open.input, "nightly sweep");

  store.closeRun(runId, {
    status: "ok",
    reply: "swept",
    steps: 3,
    usage: { inputTokens: 100, outputTokens: 20 },
  });

  const closed = store.recentRuns()[0];
  assertEquals(closed.status, "ok");
  assertEquals(closed.reply, "swept");
  assertEquals(closed.steps, 3);
  assertEquals(closed.input_tokens, 100);
  assert(closed.finished_at !== null);
  store.close();
});

Deno.test("recoverOpenRuns closes what a dead process left behind", () => {
  const store = tempStore();
  const crashed = store.openRun({
    trigger: "cli",
    input: "one",
    startedAt: "2026-08-01T00:00:00Z",
  });
  const clean = store.openRun({ trigger: "cli", input: "two", startedAt: "2026-08-01T00:00:00Z" });
  store.closeRun(clean, {
    status: "ok",
    reply: "done",
    steps: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
  });

  assertEquals(store.recoverOpenRuns(), 1);

  const rows = store.recentRuns();
  const recovered = rows.find((r) => r.id === crashed)!;
  const untouched = rows.find((r) => r.id === clean)!;
  assertEquals(recovered.status, "error_crashed");
  assert(recovered.finished_at !== null);
  assert(String(recovered.reply).includes("did not finish"));
  assertEquals(untouched.status, "ok");
  assertEquals(untouched.reply, "done");

  // Nothing is left open, so a second sweep is a no-op.
  assertEquals(store.recoverOpenRuns(), 0);
  store.close();
});

Deno.test("appendMessages continues the transcript instead of replacing it", () => {
  const store = tempStore();
  const session = store.sessionFor("k");
  store.saveMessages(session, [{ role: "user", content: "first" }]);

  store.appendMessages(session, [
    { role: "assistant", content: "second" },
    { role: "tool", toolCallId: "t1", content: "third" },
  ]);
  store.appendMessages(session, [{ role: "assistant", content: "fourth" }]);
  store.appendMessages(session, []); // no-op, and must not disturb the sequence

  assertEquals(
    store.loadMessages(session).map((m) => m.content),
    ["first", "second", "third", "fourth"],
  );

  // saveMessages stays the authority: it replaces whatever the appends wrote.
  store.saveMessages(session, [{ role: "user", content: "only" }]);
  assertEquals(store.loadMessages(session).map((m) => m.content), ["only"]);
  store.close();
});

Deno.test("run cost is recorded, and unpriced runs stay out of the totals", () => {
  const store = tempStore();
  const priced = store.openRun({ trigger: "cli", input: "a", startedAt: "2026-08-01T00:00:00Z" });
  store.closeRun(priced, {
    status: "ok",
    reply: "done",
    steps: 1,
    usage: { inputTokens: 100, outputTokens: 50 },
    cost: 1.25,
  });
  const unpriced = store.openRun({ trigger: "cli", input: "b", startedAt: "2026-08-01T00:00:00Z" });
  store.closeRun(unpriced, {
    status: "ok",
    reply: "done",
    steps: 1,
    usage: { inputTokens: 10, outputTokens: 5 },
  });

  const stats = store.runStats();
  assertEquals(stats.runs, 2);
  assertEquals(stats.cost, 1.25);
  // The unpriced run is not counted as free, it is not counted at all.
  assertEquals(stats.pricedRuns, 1);
  assertEquals(store.recentRuns().find((r) => r.id === unpriced)!.cost_usd, null);
  store.close();
});
