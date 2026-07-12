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
import { TelegramTrigger } from "./telegram.ts";
import { DiscordTrigger } from "./discord.ts";
import { SlackTrigger } from "./slack.ts";
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

Deno.test("triggersFromConfig: voice API keys resolve at startup, not first voice note", () => {
  const config = parseAgentConfig(`
handle: voice-bot
description: voice test agent
model:
  provider: openai-compatible
  id: test-model
purpose: test
voice:
  stt:
    provider: openai
  tts:
    provider: elevenlabs
triggers:
  - type: telegram
`);
  const env: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: "123:abc",
    OPENAI_API_KEY: "sk-1",
    ELEVENLABS_API_KEY: "el-1",
  };
  assertEquals(triggersFromConfig(config, (n) => env[n]).map((t) => t.name), ["telegram"]);
  const without = (name: string) => (n: string) => n === name ? undefined : env[n];
  assertThrows(
    () => triggersFromConfig(config, without("OPENAI_API_KEY")),
    Error,
    "OPENAI_API_KEY",
  );
  assertThrows(
    () => triggersFromConfig(config, without("ELEVENLABS_API_KEY")),
    Error,
    "ELEVENLABS_API_KEY",
  );
});

Deno.test("triggersFromConfig: live voice resolves its key at startup and needs a channel", () => {
  const config = parseAgentConfig(`
handle: live-bot
description: live voice test agent
model:
  provider: openai-compatible
  id: test-model
purpose: You answer questions out loud.
voice:
  live:
    provider: openai
triggers:
  - type: discord
    voice_channels: ["lounge"]
`);
  const env: Record<string, string> = { DISCORD_BOT_TOKEN: "d0k", OPENAI_API_KEY: "sk-1" };
  assertEquals(triggersFromConfig(config, (n) => env[n]).map((t) => t.name), ["discord"]);
  // A missing key strands the bot in the channel with nothing behind it; fail first.
  assertThrows(
    () => triggersFromConfig(config, (n) => n === "OPENAI_API_KEY" ? undefined : env[n]),
    Error,
    "OPENAI_API_KEY",
  );
});

Deno.test("parseAgentConfig: voice_channels without voice.live is a config error", () => {
  assertThrows(
    () =>
      parseAgentConfig(`
handle: live-bot
description: live voice test agent
model:
  provider: openai-compatible
  id: test-model
purpose: test
triggers:
  - type: discord
    voice_channels: ["lounge"]
`),
    Error,
    "voice_channels requires the top-level voice.live block",
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

Deno.test("deliver: each trigger claims only its own conversation keys", async () => {
  const telegram = new TelegramTrigger({ token: "t" });
  const discord = new DiscordTrigger({ token: "d" });
  const slack = new SlackTrigger({ token: "xoxb", appToken: "xapp" });

  // Foreign keys are handed back untouched — no network call happens.
  assertEquals(await telegram.deliver("discord:1", "hi"), false);
  assertEquals(await discord.deliver("telegram:1", "hi"), false);
  assertEquals(await slack.deliver("webhook:abc", "hi"), false);
});

Deno.test("deliver: telegram posts to the chat behind the key", async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }) as typeof fetch;
  try {
    const trigger = new TelegramTrigger({ token: "t0k" });
    assertEquals(await trigger.deliver("telegram:12345", "Reminder: do the thing."), true);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(sent.length, 1);
  assert(sent[0].url.endsWith("/bott0k/sendMessage"));
  assertEquals(sent[0].body.chat_id, "12345");
  assertEquals(sent[0].body.text, "Reminder: do the thing.");
});

Deno.test("deliver: slack threads when the key carries a thread ts", async () => {
  const sent: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }) as typeof fetch;
  try {
    const trigger = new SlackTrigger({ token: "xoxb", appToken: "xapp" });
    await trigger.deliver("slack:C123:1712.345", "in the thread");
    await trigger.deliver("slack:D999", "flat dm");
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(sent[0], { channel: "C123", text: "in the thread", thread_ts: "1712.345" });
  assertEquals(sent[1], { channel: "D999", text: "flat dm" });
});
