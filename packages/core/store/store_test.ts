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

Deno.test("clearSession wipes one conversation's transcript, nothing else", () => {
  const store = tempStore();
  const a = store.sessionFor("cli");
  const b = store.sessionFor("discord:thread:123");
  store.saveMessages(a, [{ role: "user", content: "hi" }]);
  store.saveMessages(b, [{ role: "user", content: "other thread" }]);

  assert(store.clearSession("cli"));
  assertEquals(store.loadMessages(a), []);
  assertEquals(store.loadMessages(b).length, 1);
  // Already empty and unknown keys report nothing to clear:
  assertEquals(store.clearSession("cli"), false);
  assertEquals(store.clearSession("never-seen"), false);
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
