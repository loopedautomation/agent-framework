// The meet trigger: same WebSocket transport as tty, opposite contract. The
// meeting is the conversation, so the meeting id is a required handshake and
// connections come and go inside it. These tests cover the four things that
// distinguish it from a terminal: the gate, the key, reconnect, and the end.
import { assert, assertEquals } from "@std/assert";
import {
  AgentService,
  type Completion,
  type CompletionRequest,
  parseAgentConfig,
  type Provider,
} from "@looped/core";
import { type MeetServerFrame, MeetTrigger } from "./meet.ts";
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
purpose: You take part in meetings.
triggers:
  - type: meet
    token_env: MEET_TOKEN
    summarize_on_end: "The meeting is over. Write the record of it."
memory:
  scope: thread
`);

async function startService(script: Partial<Completion>[], summarizeOnEnd?: string) {
  const service = new AgentService({
    config: CONFIG,
    provider: scripted(script),
    dataDir: await Deno.makeTempDir(),
    identity: { name: "meet-bot", isNew: false, source: "chosen" },
  });
  let port = 0;
  const trigger = new MeetTrigger({
    path: "/meet",
    port: 0,
    token: "s3cret",
    handle: "meet-bot",
    name: "Juniper",
    description: "meet trigger test agent",
    summarizeOnEnd,
    onListen: (addr) => (port = addr.port),
  });
  await service.start([trigger]);
  return { service, trigger, port: () => port };
}

function connect(url: string) {
  const socket = new WebSocket(url, ["bearer.s3cret"]);
  const frames: MeetServerFrame[] = [];
  const waiters: Array<{ done: (f: MeetServerFrame) => boolean; resolve: () => void }> = [];
  socket.onmessage = (msg) => {
    const frame = JSON.parse(String(msg.data)) as MeetServerFrame;
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
  const until = (done: (f: MeetServerFrame) => boolean) =>
    new Promise<void>((resolve) => waiters.push({ done, resolve }));
  const send = (frame: unknown) => socket.send(JSON.stringify(frame));
  return { socket, frames, opened, until, send };
}

Deno.test("meet: nothing happens before a join names the meeting", async () => {
  const { service, port } = await startService([{ content: "should not run" }]);
  const c = connect(`ws://127.0.0.1:${port()}/meet`);
  await c.opened;

  // This is the whole reason the trigger exists: without a meeting id there
  // is no stable conversation, so the runtime refuses rather than inventing
  // one and orphaning the history.
  c.send({ type: "input", text: "hello?" });
  await c.until((f) => f.type === "error");
  assert((c.frames.at(-1) as { error: string }).error.includes("join"));

  c.send({ type: "join", meeting_id: "" });
  await c.until((f) => f.type === "error" && f.error.includes("meeting_id"));

  c.socket.close();
  await service.stop();
});

Deno.test("meet: the meeting id is the conversation key, so a reconnect resumes", async () => {
  const { service, port } = await startService([
    { content: "noted" },
    { content: "I remember" },
  ]);
  const url = `ws://127.0.0.1:${port()}/meet`;

  const first = connect(url);
  await first.opened;
  first.send({ type: "join", meeting_id: "room-42" });
  await first.until((f) => f.type === "hello");
  assertEquals((first.frames[0] as { meeting_id: string }).meeting_id, "room-42");
  // Nothing was open on this meeting before, so this is a fresh one.
  assertEquals((first.frames[0] as { resumed: boolean }).resumed, false);

  first.send({ type: "input", text: "remember the budget is 40k" });
  await first.until((f) => f.type === "result");
  // The socket dropping is not the meeting ending.
  first.socket.close();
  await new Promise((r) => setTimeout(r, 20));

  const second = connect(url);
  await second.opened;
  second.send({ type: "join", meeting_id: "room-42" });
  await second.until((f) => f.type === "hello");
  second.send({ type: "input", text: "what was the budget?" });
  await second.until((f) => f.type === "result");

  // The second connection ran against the first's history, which is the
  // behaviour a per-connection conversation could never give.
  const key = service.store.sessionFor("meet:room-42");
  const history = service.store.loadMessages(key).map((m) => m.content);
  assert(history.includes("remember the budget is 40k"), history.join(" | "));
  assert(history.includes("what was the budget?"), history.join(" | "));

  second.socket.close();
  await service.stop();
});

Deno.test("meet: two meetings do not share a conversation", async () => {
  const { service, port } = await startService([{ content: "ok" }]);
  const url = `ws://127.0.0.1:${port()}/meet`;

  for (const id of ["room-a", "room-b"]) {
    const c = connect(url);
    await c.opened;
    c.send({ type: "join", meeting_id: id });
    await c.until((f) => f.type === "hello");
    c.send({ type: "input", text: `talking in ${id}` });
    await c.until((f) => f.type === "result");
    c.socket.close();
    await new Promise((r) => setTimeout(r, 10));
  }

  const a = service.store.loadMessages(service.store.sessionFor("meet:room-a"));
  const b = service.store.loadMessages(service.store.sessionFor("meet:room-b"));
  assert(a.some((m) => m.content === "talking in room-a"));
  assert(!a.some((m) => m.content === "talking in room-b"));
  assert(b.some((m) => m.content === "talking in room-b"));

  await service.stop();
});

Deno.test("meet: an end frame writes the record while the context is still live", async () => {
  const { service, port } = await startService(
    [{ content: "noted" }, { content: "We agreed the budget is 40k." }],
    "The meeting is over. Write the record of it.",
  );
  const c = connect(`ws://127.0.0.1:${port()}/meet`);
  await c.opened;
  c.send({ type: "join", meeting_id: "room-99" });
  await c.until((f) => f.type === "hello");
  c.send({ type: "input", text: "the budget is 40k" });
  await c.until((f) => f.type === "result");

  c.send({ type: "end", reason: "host left" });
  await c.until((f) => f.type === "summary");
  const summary = c.frames.find((f) => f.type === "summary") as { text: string };
  assertEquals(summary.text, "We agreed the budget is 40k.");

  // The summary is a real turn, so it is in the transcript rather than only
  // on the wire: that record is what outlives the meeting.
  const history = service.store.loadMessages(service.store.sessionFor("meet:room-99"));
  assert(history.some((m) => m.content === "We agreed the budget is 40k."));
  await service.stop();
});

Deno.test("meet: without summarize_on_end an ending costs no model call", async () => {
  // Only one scripted completion: a summary run would need a second and the
  // script would repeat it, so a spurious summary shows up as an extra turn.
  const { service, port } = await startService([{ content: "noted" }], undefined);
  const c = connect(`ws://127.0.0.1:${port()}/meet`);
  await c.opened;
  c.send({ type: "join", meeting_id: "room-quiet" });
  await c.until((f) => f.type === "hello");
  c.send({ type: "input", text: "hello" });
  await c.until((f) => f.type === "result");

  const before = service.store.loadMessages(service.store.sessionFor("meet:room-quiet")).length;
  c.send({ type: "end" });
  await new Promise((r) => setTimeout(r, 60));
  const after = service.store.loadMessages(service.store.sessionFor("meet:room-quiet")).length;
  assertEquals(after, before);

  assert(!c.frames.some((f) => f.type === "summary"));
  await service.stop();
});

Deno.test("meet: participants are recorded without spending a turn", async () => {
  const { service, port } = await startService([{ content: "ok" }]);
  const c = connect(`ws://127.0.0.1:${port()}/meet`);
  await c.opened;
  c.send({ type: "join", meeting_id: "room-7", participants: ["ratul"] });
  await c.until((f) => f.type === "hello");

  const before = service.store.loadMessages(service.store.sessionFor("meet:room-7")).length;
  c.send({ type: "participant", name: "sam", action: "joined" });
  c.send({ type: "participant", name: "sam", action: "left" });
  await new Promise((r) => setTimeout(r, 40));
  // A busy room would otherwise start a run per arrival.
  assertEquals(
    service.store.loadMessages(service.store.sessionFor("meet:room-7")).length,
    before,
  );
  assert(!c.frames.some((f) => f.type === "error"));

  c.send({ type: "participant", name: "sam", action: "exploded" });
  await c.until((f) => f.type === "error");

  c.socket.close();
  await service.stop();
});

Deno.test("meet: unauthorized upgrades are refused before any frame", async () => {
  const { service, port } = await startService([{ content: "ok" }]);
  const res = await fetch(`http://127.0.0.1:${port()}/meet`, {
    headers: { upgrade: "websocket", authorization: "Bearer wrong" },
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
  await service.stop();
});

Deno.test("triggersFromConfig: builds a meet trigger, and names a missing token", () => {
  const built = triggersFromConfig(CONFIG, (k) => (k === "MEET_TOKEN" ? "s3cret" : undefined));
  assertEquals(built.map((t) => t.name), ["meet"]);

  let message = "";
  try {
    triggersFromConfig(CONFIG, () => undefined);
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message.includes("MEET_TOKEN"), message);
});
