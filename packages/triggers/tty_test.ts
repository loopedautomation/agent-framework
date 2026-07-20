// The tty trigger: a WebSocket terminal that streams run progress live —
// auth (header and browser-subprotocol), streamed frames, session resume,
// and proactive delivery into an open terminal.
import { assert, assertEquals } from "@std/assert";
import {
  AgentService,
  type Completion,
  type CompletionRequest,
  parseAgentConfig,
  type Provider,
} from "@looped/core";
import { type TtyServerFrame, TtyTrigger } from "./tty.ts";
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
handle: tty-bot
description: tty trigger test agent
model:
  provider: openai-compatible
  id: test-model
purpose: You run commands when asked.
triggers:
  - type: tty
    token_env: TTY_TOKEN
permissions:
  run: [echo]
memory:
  scope: thread
`);

async function startService(script: Partial<Completion>[]) {
  const dataDir = await Deno.makeTempDir();
  const service = new AgentService({
    config: CONFIG,
    provider: scripted(script),
    dataDir,
    // Skip the naming ritual so the script isn't consumed by it.
    identity: { name: "tty-bot", isNew: false },
  });
  let port = 0;
  const trigger = new TtyTrigger({
    path: "/tty",
    port: 0, // ephemeral; captured via onListen
    token: "s3cret",
    handle: "tty-bot",
    name: "Juniper", // the self-chosen name, distinct from the handle
    description: "tty trigger test agent",
    onListen: (addr) => (port = addr.port),
  });
  await service.start([trigger]);
  return { service, trigger, port: () => port };
}

/** Connect and collect frames until the predicate says the turn is over. */
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

Deno.test("tty: auth, streamed run frames, and session memory", async () => {
  const { service, port } = await startService([
    { toolCalls: [{ id: "c1", name: "run_bash", arguments: '{"command":"echo hello"}' }] },
    { content: "ran echo: hello" },
  ]);
  const base = `ws://127.0.0.1:${port()}/tty`;

  // Plain HTTP request without upgrade → 426.
  const plain = await fetch(`http://127.0.0.1:${port()}/tty`);
  assertEquals(plain.status, 426);
  await plain.body?.cancel();

  // Wrong token → connection refused with 401 (socket errors out).
  const bad = new WebSocket(base, ["bearer.wrong"]);
  await new Promise<void>((resolve) => {
    bad.onerror = () => resolve();
    bad.onclose = () => resolve();
  });

  // Browser-style auth: token in the subprotocol; server selects "bearer".
  const term = connect(`${base}?conversation_id=demo`, ["bearer.s3cret"]);
  await term.opened;
  assertEquals(term.socket.protocol, "bearer.s3cret");
  const helloSeen = term.until((f) => f.type === "hello");
  const resultSeen = term.until((f) => f.type === "result");
  term.socket.send(JSON.stringify({ type: "input", text: "run echo hello" }));
  await helloSeen;
  await resultSeen;

  const hello = term.frames.find((f) => f.type === "hello");
  assert(hello && hello.type === "hello");
  assertEquals(hello.handle, "tty-bot");
  assertEquals(hello.name, "Juniper"); // the self-chosen name, not the handle
  assertEquals(hello.description, "tty trigger test agent");
  assertEquals(hello.conversation_id, "demo");

  // The run streamed live: a tool_result frame arrived before the result.
  const types = term.frames.map((f) => f.type);
  assert(types.indexOf("tool_result") !== -1, `expected tool_result in ${types}`);
  assert(types.indexOf("tool_result") < types.indexOf("result"));
  const result = term.frames.find((f) => f.type === "result");
  assert(result && result.type === "result");
  assertEquals(result.status, "ok");
  assertEquals(result.reply, "ran echo: hello");

  // Session memory landed under the conversation key.
  const sessionId = service.store.sessionFor("tty:demo");
  assert(service.store.loadMessages(sessionId).length >= 2);

  term.socket.close();
  await service.stop();
});

Deno.test("tty: malformed frames get errors, deliver reaches an open terminal", async () => {
  const { service, trigger, port } = await startService([{ content: "hi" }]);
  const term = connect(`ws://127.0.0.1:${port()}/tty?conversation_id=demo`, ["bearer.s3cret"]);
  await term.opened;
  await term.until((f) => f.type === "hello");

  const errSeen = term.until((f) => f.type === "error");
  term.socket.send("not json");
  await errSeen;

  const err2Seen = term.until((f) => f.type === "error" && f.error.includes("input"));
  term.socket.send(JSON.stringify({ type: "input", text: "" }));
  await err2Seen;

  // Proactive delivery: an open terminal on the key gets the message.
  const msgSeen = term.until((f) => f.type === "message");
  assertEquals(await trigger.deliver("tty:demo", "reminder!"), true);
  await msgSeen;
  const msg = term.frames.find((f) => f.type === "message");
  assert(msg && msg.type === "message" && msg.text === "reminder!");

  // No terminal on that key → the key is handed to the next trigger.
  assertEquals(await trigger.deliver("tty:absent", "lost"), false);

  term.socket.close();
  await service.stop();
});

Deno.test("tty: a cancel frame aborts the in-flight run; the socket keeps going", async () => {
  const dataDir = await Deno.makeTempDir();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  // The first turn holds at its provider call until the test cancels it; the
  // second runs to completion, proving the socket accepts input after a cancel.
  const provider: Provider = {
    id: "mock",
    async complete(): Promise<Completion> {
      calls++;
      if (calls === 1) await gate;
      return {
        content: calls === 1 ? "" : "second turn ran",
        toolCalls: calls === 1 ? [{ id: "t1", name: "nonexistent", arguments: "{}" }] : [],
        stopReason: calls === 1 ? "tool_calls" : "end",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const service = new AgentService({
    config: CONFIG,
    provider,
    dataDir,
    identity: { name: "tty-bot", isNew: false },
  });
  let port = 0;
  const trigger = new TtyTrigger({
    path: "/tty",
    port: 0,
    token: "s3cret",
    handle: "tty-bot",
    name: "tty-bot",
    onListen: (addr) => (port = addr.port),
  });
  await service.start([trigger]);

  const term = connect(`ws://127.0.0.1:${port}/tty?conversation_id=cancel`, ["bearer.s3cret"]);
  await term.opened;
  await term.until((f) => f.type === "hello");

  const abortedSeen = term.until((f) => f.type === "result");
  term.socket.send(JSON.stringify({ type: "input", text: "count forever" }));
  // Wait until the run holds its provider call, then cancel it from the socket.
  while (calls === 0) await new Promise((r) => setTimeout(r, 5));
  term.socket.send(JSON.stringify({ type: "cancel" }));
  // Frames are ordered per socket, so an empty input queued right after cancel
  // answers only once the server has processed the cancel. Awaiting its error
  // frame is our fence: the abort has fired before we release the gate.
  const fenceSeen = term.until((f) => f.type === "error");
  term.socket.send(JSON.stringify({ type: "input", text: "" }));
  await fenceSeen;
  release();
  await abortedSeen;

  const aborted = term.frames.find((f) => f.type === "result");
  assert(aborted && aborted.type === "result");
  assertEquals(aborted.status, "aborted");
  assertEquals(calls, 1); // the aborted loop made no further provider call

  // No reconnect: the next input runs on the same socket.
  const okSeen = term.until((f) => f.type === "result" && f.reply === "second turn ran");
  term.socket.send(JSON.stringify({ type: "input", text: "again" }));
  await okSeen;

  term.socket.close();
  await service.stop();
});

Deno.test("triggersFromConfig: builds tty trigger, fails loudly on missing token", () => {
  const built = triggersFromConfig(CONFIG, (name) => name === "TTY_TOKEN" ? "tok" : undefined);
  assertEquals(built.length, 1);
  assertEquals(built[0].name, "tty");

  let threw = false;
  try {
    triggersFromConfig(CONFIG, () => undefined);
  } catch (err) {
    threw = true;
    assert((err as Error).message.includes("TTY_TOKEN"));
  }
  assert(threw);
});

Deno.test("tty: input images reach the model; malformed images are rejected", async () => {
  // A capturing provider so we can assert what the model actually saw.
  const requests: CompletionRequest[] = [];
  const provider: Provider = {
    id: "mock",
    complete(req: CompletionRequest): Promise<Completion> {
      requests.push(req);
      return Promise.resolve({
        content: "I can see your screen.",
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
  };
  const dataDir = await Deno.makeTempDir();
  const service = new AgentService({
    config: CONFIG,
    provider,
    dataDir,
    identity: { name: "tty-bot", isNew: false },
  });
  let port = 0;
  const trigger = new TtyTrigger({
    path: "/tty",
    port: 0,
    token: "s3cret",
    handle: "tty-bot",
    name: "tty-bot",
    onListen: (addr) => (port = addr.port),
  });
  await service.start([trigger]);

  const term = connect(`ws://127.0.0.1:${port}/tty?conversation_id=img`, ["bearer.s3cret"]);
  await term.opened;
  await term.until((f) => f.type === "hello");

  // A bad image is refused before any run starts.
  const errSeen = term.until((f) => f.type === "error" && f.error.includes("images"));
  term.socket.send(JSON.stringify({
    type: "input",
    text: "look",
    images: [{ mediaType: "image/tiff", data: "AAAA" }],
  }));
  await errSeen;
  assertEquals(requests.length, 0);

  // A valid image rides the turn into the model request.
  const resultSeen = term.until((f) => f.type === "result");
  term.socket.send(JSON.stringify({
    type: "input",
    text: "what's on my screen?",
    images: [{ mediaType: "image/jpeg", data: "aGVsbG8=" }],
  }));
  await resultSeen;
  assertEquals(requests.length, 1);
  const userMsg = requests[0].messages.find((m) =>
    m.role === "user" && m.content.includes("screen")
  );
  assert(userMsg && userMsg.role === "user");
  assertEquals(userMsg.images?.length, 1);
  assertEquals(userMsg.images?.[0].mediaType, "image/jpeg");

  term.socket.close();
  await service.stop();
});
