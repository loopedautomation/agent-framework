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
    costUsd: 0.00012,
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
