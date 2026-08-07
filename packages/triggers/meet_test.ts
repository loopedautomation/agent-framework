// The meet trigger: the tty protocol under a meet identity — self-registration
// with the instance on start, `meet:` conversation keys, and proactive
// delivery down a live socket or over meet's messages API.
import { assert, assertEquals } from "@std/assert";
import {
  AgentService,
  type Completion,
  type CompletionRequest,
  parseAgentConfig,
  type Provider,
  type RunResult,
} from "@looped/core";
import { MeetTrigger } from "./meet.ts";
import type { TtyServerFrame } from "./tty.ts";
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
handle: meet-bot
description: meet trigger test agent
model:
  provider: openai-compatible
  id: test-model
purpose: You attend meetings.
triggers:
  - type: meet
    base_url: https://meet.example.com
    public_url: https://agent.example.com
    token_env: MEET_AGENT_TOKEN
    registration_token_env: MEET_REGISTRATION_TOKEN
memory:
  scope: thread
`);

/** A fetch mock that records calls and replays scripted responses. */
function fetchMock(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)];
    return Promise.resolve(
      new Response(JSON.stringify(r.body ?? {}), { status: r.status }),
    );
  }) as typeof fetch;
  return { calls, impl };
}

function makeTrigger(
  opts: { fetch: typeof fetch; onListen?: (addr: { port: number }) => void },
) {
  return new MeetTrigger({
    baseUrl: "https://meet.example.com",
    publicUrl: "https://agent.example.com",
    path: "/meet",
    port: 0,
    token: "ws-s3cret",
    registrationToken: "lreg_test",
    handle: "meet-bot",
    name: "Juniper",
    description: "meet trigger test agent",
    onListen: opts.onListen ?? (() => {}),
    fetch: opts.fetch,
    registrationRetryMs: 1,
  });
}

async function startService(script: Partial<Completion>[], fetchImpl: typeof fetch) {
  const dataDir = await Deno.makeTempDir();
  const service = new AgentService({
    config: CONFIG,
    provider: scripted(script),
    dataDir,
    identity: { name: "Juniper", isNew: false, source: "chosen" },
  });
  let port = 0;
  const trigger = makeTrigger({ fetch: fetchImpl, onListen: (addr) => (port = addr.port) });
  await service.start([trigger]);
  return { service, trigger, port: () => port };
}

function connect(url: string, protocols?: string[]) {
  const socket = new WebSocket(url, protocols);
  const frames: TtyServerFrame[] = [];
  const waiters: Array<{ done: (f: TtyServerFrame) => boolean; resolve: () => void }> = [];
  socket.onmessage = (msg) => {
    const frame = JSON.parse(String(msg.data)) as TtyServerFrame;
    frames.push(frame);
    for (const w of [...waiters]) {
      if (w.done(frame)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };
  const opened = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("socket error"));
  });
  const until = (done: (f: TtyServerFrame) => boolean) =>
    new Promise<void>((resolve) => waiters.push({ done, resolve }));
  return { socket, frames, opened, until };
}

/** A no-op emit for tests that never dispatch a run. */
const emitStub = (): Promise<RunResult> =>
  Promise.resolve(
    {
      status: "ok",
      reply: "",
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [],
    } as unknown as RunResult,
  );

/** Wait until the predicate holds (registration runs fire-and-forget). */
async function eventually(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert(check(), what);
}

Deno.test("meet: registers on start, serves the tty protocol under meet keys", async () => {
  const reg = fetchMock([{ status: 200, body: { ok: true, agentId: "ext-1" } }]);
  const { service, port } = await startService([{ content: "hello from the meeting" }], reg.impl);

  // Registration fired with the exact contract: bearer token, dial-back wss URL.
  await eventually(() => reg.calls.length === 1, "registration call fired");
  assertEquals(reg.calls[0].url, "https://meet.example.com/api/agents/register");
  const headers = reg.calls[0].init.headers as Record<string, string>;
  assertEquals(headers.authorization, "Bearer lreg_test");
  assertEquals(JSON.parse(String(reg.calls[0].init.body)), {
    name: "Juniper",
    description: "meet trigger test agent",
    url: "wss://agent.example.com/meet",
    token: "ws-s3cret",
  });

  // The bridge-side protocol is the tty protocol, under the meet identity.
  const term = connect(
    `ws://127.0.0.1:${port()}/meet?conversation_id=meet-text-abc`,
    ["bearer.ws-s3cret"],
  );
  await term.opened;
  const resultSeen = term.until((f) => f.type === "result");
  term.socket.send(JSON.stringify({ type: "input", text: "say hi" }));
  await resultSeen;

  const hello = term.frames.find((f) => f.type === "hello");
  assert(hello && hello.type === "hello");
  assertEquals(hello.handle, "meet-bot");
  assertEquals(hello.name, "Juniper");

  // Session memory landed under the meet-prefixed conversation key.
  const sessionId = service.store.sessionFor("meet:meet-text-abc");
  assert(service.store.loadMessages(sessionId).length >= 2);

  term.socket.close();
  await service.stop();
});

Deno.test("meet: registration retries 5xx, gives up on 4xx, never blocks serving", async () => {
  // 500 then 200: the retry succeeds.
  const retry = fetchMock([{ status: 500 }, { status: 200, body: { ok: true } }]);
  const t1 = makeTrigger({ fetch: retry.impl });
  await t1.start(emitStub, () => false);
  await eventually(() => retry.calls.length === 2, "5xx retried");
  await t1.stop();

  // 401: a config problem — no retry storm against a token that can't work.
  const rejected = fetchMock([{ status: 401 }]);
  const t2 = makeTrigger({ fetch: rejected.impl });
  await t2.start(emitStub, () => false);
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(rejected.calls.length, 1);
  await t2.stop();

  // Permanent 5xx: registration gives up, but the server still accepted the
  // start — an unregistered agent serves inbound dials.
  const down = fetchMock([{ status: 503 }]);
  let port = 0;
  const t3 = new MeetTrigger({
    baseUrl: "https://meet.example.com",
    publicUrl: "https://agent.example.com",
    path: "/meet",
    port: 0,
    token: "ws-s3cret",
    registrationToken: "lreg_test",
    handle: "meet-bot",
    name: "meet-bot",
    onListen: (addr) => (port = addr.port),
    fetch: down.impl,
    registrationRetryMs: 1,
  });
  await t3.start(emitStub, () => false);
  await eventually(() => down.calls.length === 5, "all attempts consumed");
  const plain = await fetch(`http://127.0.0.1:${port}/meet`);
  assertEquals(plain.status, 426); // the server is up and answering
  await plain.body?.cancel();
  await t3.stop();
});

Deno.test("meet: deliver prefers a live socket, falls back to the messages API", async () => {
  const net = fetchMock([
    { status: 200, body: { ok: true } }, // registration
    { status: 200 }, // first messages-API delivery
    { status: 404 }, // second: unknown channel
  ]);
  const { service, trigger, port } = await startService([{ content: "hi" }], net.impl);
  await eventually(() => net.calls.length === 1, "registration call fired");

  // Not our key: hand it to the next trigger, no network call.
  assertEquals(await trigger.deliver("telegram:123", "nope"), false);

  // Live socket on the key: the frame goes down the socket, not over HTTP.
  const term = connect(
    `ws://127.0.0.1:${port()}/meet?conversation_id=meet-text-abc`,
    ["bearer.ws-s3cret"],
  );
  await term.opened;
  await term.until((f) => f.type === "hello");
  const msgSeen = term.until((f) => f.type === "message");
  assertEquals(await trigger.deliver("meet:meet-text-abc", "reminder!"), true);
  await msgSeen;
  assertEquals(net.calls.length, 1); // still just the registration call

  // No socket + a text-channel key: POST the messages API.
  assertEquals(await trigger.deliver("meet:meet-text-standup", "daily summary"), true);
  assertEquals(net.calls.length, 2);
  assertEquals(net.calls[1].url, "https://meet.example.com/api/agents/messages");
  assertEquals(JSON.parse(String(net.calls[1].init.body)), {
    channel: "standup",
    text: "daily summary",
  });

  // The API saying 404 (unknown channel) → false, so the service logs it.
  assertEquals(await trigger.deliver("meet:meet-text-gone", "lost"), false);

  // A meeting-room key with no live socket has nowhere durable to land.
  assertEquals(await trigger.deliver("meet:room-xyz", "lost"), false);
  assertEquals(net.calls.length, 3); // no call for the room key

  term.socket.close();
  await service.stop();
});

Deno.test("triggersFromConfig: builds meet trigger, fails loudly on missing tokens", () => {
  const env = (name: string) =>
    name === "MEET_AGENT_TOKEN" ? "tok" : name === "MEET_REGISTRATION_TOKEN" ? "lreg_x" : undefined;
  const built = triggersFromConfig(CONFIG, env);
  assertEquals(built.length, 1);
  assertEquals(built[0].name, "meet");

  for (const missing of ["MEET_AGENT_TOKEN", "MEET_REGISTRATION_TOKEN"]) {
    let threw = false;
    try {
      triggersFromConfig(CONFIG, (name) => name === missing ? undefined : env(name));
    } catch (err) {
      threw = true;
      assert((err as Error).message.includes(missing));
    }
    assert(threw, `expected a throw for unset ${missing}`);
  }
});
