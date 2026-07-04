// The M2 exit demo, as a test: a curl-shaped request triggers the agent,
// a permitted command runs, a denied command fails cleanly, and both the
// run and the denial land in the audit trail.
import { assert, assertEquals } from "@std/assert";
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

Deno.test("cron trigger fires with its configured prompt", async () => {
  const events: string[] = [];
  const results: string[] = [];
  const trigger = new CronTrigger({
    schedule: "* * * * * *", // every second
    prompt: "do the daily thing",
    onResult: (r) => results.push(r.status),
  });
  await trigger.start((event) => {
    events.push(event.input);
    return Promise.resolve({
      status: "ok" as const,
      reply: "done",
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      messages: [],
    });
  });
  await new Promise((r) => setTimeout(r, 1500));
  await trigger.stop();
  assert(events.length >= 1);
  assertEquals(events[0], "do the daily thing");
  assertEquals(results[0], "ok");
});
