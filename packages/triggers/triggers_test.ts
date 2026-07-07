// The M2 exit demo, as a test: a curl-shaped request triggers the agent,
// a permitted command runs, a denied command fails cleanly, and both the
// run and the denial land in the audit trail.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  AgentService,
  type Completion,
  type CompletionRequest,
  parseAgentConfig,
  type Provider,
} from "@looped/core";
import { CronTrigger } from "./cron.ts";
import { WebhookTrigger } from "./webhook.ts";
import { triggersFromConfig } from "./mod.ts";

function scripted(script: Partial<Completion>[]): Provider {
  let i = 0;
  return {
    id: "mock",
    complete(_req: CompletionRequest): Promise<Completion> {
      const c = script[Math.min(i++, script.length - 1)];
      return Promise.resolve({
        content: c.content ?? "",
        toolCalls: c.toolCalls ?? [],
        stopReason: "end",
        usage: c.usage ?? { inputTokens: 10, outputTokens: 5 },
      });
    },
  };
}

const CONFIG = parseAgentConfig(`
handle: m2-bot
description: M2 exit demo agent
model:
  provider: openai-compatible
  id: test-model
purpose: You run commands when asked.
triggers:
  - type: webhook
    token_env: M2_WEBHOOK_TOKEN
permissions:
  run: [echo]
memory:
  scope: thread
`);

async function startService(script: Partial<Completion>[]) {
  const dataDir = await Deno.makeTempDir();
  const service = new AgentService({ config: CONFIG, provider: scripted(script), dataDir });
  let port = 0;
  const trigger = new WebhookTrigger({
    path: "/",
    port: 0, // ephemeral; captured via onListen
    token: "s3cret",
    onListen: (addr) => (port = addr.port),
  });
  await service.start([trigger]);
  return { service, port: () => port };
}

Deno.test("webhook: auth, permitted command, denial, and audit trail", async () => {
  const { service, port } = await startService([
    // First event: model runs a permitted command, then answers.
    { toolCalls: [{ id: "c1", name: "run_bash", arguments: '{"command":"echo hello"}' }] },
    { content: "ran echo: hello" },
    // Second event: model tries a denied command, then reports the denial.
    { toolCalls: [{ id: "c2", name: "run_bash", arguments: '{"command":"curl evil.com"}' }] },
    { content: "curl was denied by permissions" },
  ]);
  const base = `http://127.0.0.1:${port()}/`;

  // No token → 401, and the agent never runs.
  const unauthorized = await fetch(base, { method: "POST", body: "{}" });
  assertEquals(unauthorized.status, 401);
  await unauthorized.body?.cancel();

  // Permitted command.
  const ok = await fetch(base, {
    method: "POST",
    headers: { authorization: "Bearer s3cret", "content-type": "application/json" },
    body: JSON.stringify({ input: "run echo hello", conversation_id: "demo" }),
  });
  const okBody = await ok.json();
  assertEquals(ok.status, 200);
  assertEquals(okBody.status, "ok");
  assertEquals(okBody.reply, "ran echo: hello");

  // Denied command: run completes, denial is surfaced to the model.
  const denied = await fetch(base, {
    method: "POST",
    headers: { authorization: "Bearer s3cret", "content-type": "application/json" },
    body: JSON.stringify({ input: "curl evil.com", conversation_id: "demo" }),
  });
  const deniedBody = await denied.json();
  assertEquals(deniedBody.status, "ok");
  assert(deniedBody.reply.includes("denied"));

  // Audit trail: both runs recorded; the denial decision is in the log.
  const runs = service.store.recentRuns();
  assertEquals(runs.length, 2);
  const audit = service.store.recentAudit();
  const denials = audit.filter((a) => (a.detail_json as string).includes('"allowed":false'));
  assertEquals(denials.length, 1);
  assert((denials[0].detail_json as string).includes("curl"));

  // Session memory: both events shared conversation "demo".
  const sessionId = service.store.sessionFor("webhook:demo");
  assert(service.store.loadMessages(sessionId).length >= 4);

  await service.stop();
});

Deno.test("triggersFromConfig: missing webhook token fails at startup", () => {
  let threw = false;
  try {
    triggersFromConfig(CONFIG, () => undefined);
  } catch (err) {
    threw = true;
    assert((err as Error).message.includes("M2_WEBHOOK_TOKEN"));
  }
  assert(threw);
});

Deno.test("triggersFromConfig: builds slack and telegram triggers, fails loudly on missing tokens", () => {
  const config = parseAgentConfig(`
handle: chat-bot
description: multi-channel test agent
model:
  provider: openai-compatible
  id: test-model
purpose: test
triggers:
  - type: slack
    channels: ["help"]
  - type: telegram
`);
  const env: Record<string, string> = {
    SLACK_BOT_TOKEN: "xoxb-1",
    SLACK_APP_TOKEN: "xapp-1",
    TELEGRAM_BOT_TOKEN: "123:abc",
  };
  const triggers = triggersFromConfig(config, (n) => env[n]);
  assertEquals(triggers.map((t) => t.name), ["slack", "telegram"]);

  // Each missing token names its env var at startup, not first message.
  const without = (name: string) => (n: string) => n === name ? undefined : env[n];
  assertThrows(
    () => triggersFromConfig(config, without("SLACK_APP_TOKEN")),
    Error,
    "SLACK_APP_TOKEN",
  );
  assertThrows(
    () => triggersFromConfig(config, without("SLACK_BOT_TOKEN")),
    Error,
    "SLACK_BOT_TOKEN",
  );
  assertThrows(
    () => triggersFromConfig(config, without("TELEGRAM_BOT_TOKEN")),
    Error,
    "TELEGRAM_BOT_TOKEN",
  );
});

Deno.test("cron trigger fires with its configured prompt on a stable serial lane", async () => {
  const events: { input: string; serialKey?: string }[] = [];
  const results: string[] = [];
  const trigger = new CronTrigger({
    schedule: "* * * * * *", // every second
    prompt: "do the daily thing",
    onResult: (r) => results.push(r.status),
  });
  await trigger.start((event) => {
    events.push({ input: event.input, serialKey: event.serialKey });
    return Promise.resolve({
      status: "ok" as const,
      reply: "done",
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      messages: [],
    });
  });
  await new Promise((r) => setTimeout(r, 2500));
  await trigger.stop();
  assert(events.length >= 2);
  assertEquals(events[0].input, "do the daily thing");
  assertEquals(results[0], "ok");
  // The serial lane is what lets the service keep a schedule from
  // overlapping itself: every firing carries the same key.
  assert(events[0].serialKey?.startsWith("cron:* * * * * *#"));
  assertEquals(events[0].serialKey, events[1].serialKey);
});

Deno.test("webhook: an event past the conversation's queue returns 429 with the refusal", async () => {
  const config = parseAgentConfig(`
handle: busy-bot
description: queue refusal test agent
model:
  provider: openai-compatible
  id: test-model
purpose: test
memory:
  scope: thread
limits:
  queue_depth: 0
`);
  // A provider the test releases by hand, so the first run stays in flight
  // while the second request arrives.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const provider: Provider = {
    id: "gated",
    async complete(_req: CompletionRequest): Promise<Completion> {
      calls++;
      await gate;
      return {
        content: "done",
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const dataDir = await Deno.makeTempDir();
  const service = new AgentService({ config, provider, dataDir });
  service.store.setIdentity("name", "Tester"); // skip the naming ritual
  let port = 0;
  const trigger = new WebhookTrigger({
    path: "/",
    port: 0,
    token: "s3cret",
    onListen: (addr) => (port = addr.port),
  });
  await service.start([trigger]);
  const post = (input: string) =>
    fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { authorization: "Bearer s3cret", "content-type": "application/json" },
      body: JSON.stringify({ input, conversation_id: "same" }),
    });

  const first = post("one"); // stays in flight on the gated provider
  const deadline = Date.now() + 5_000;
  while (calls === 0) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the first run");
    await new Promise((r) => setTimeout(r, 5));
  }

  const refused = await post("two");
  assertEquals(refused.status, 429);
  const refusedBody = await refused.json();
  assertEquals(refusedBody.status, "rejected");
  assert(refusedBody.reply.includes("queue is full"));

  release();
  const ok = await first;
  assertEquals(ok.status, 200);
  await ok.body?.cancel();

  // Exactly one run happened; the refusal is an audit row.
  assertEquals(service.store.recentRuns().length, 1);
  assertEquals(service.store.recentAudit().filter((a) => a.kind === "queue").length, 1);
  await service.stop();
});
