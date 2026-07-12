import { assert, assertEquals } from "@std/assert";
import { DiscordTrigger } from "./discord.ts";
import type { DiscordVoiceSession, VoiceServerInfo } from "./discord_voice.ts";
import type { AgentEvent, RunResult } from "@looped/core";

// The live voice join is spread across three gateway events, so what's worth
// testing is the state machine that assembles them: does the trigger ask to
// join the right channel, does it wait for both halves of the voice server's
// identity, and is the delegate it hands the session actually the agent loop?

/** A voice session that records what it was told, in place of a real one. */
function fakeSession() {
  const started: VoiceServerInfo[] = [];
  let stopped = 0;
  let delegate: ((prompt: string) => Promise<string>) | undefined;
  const session = {
    start: (server: VoiceServerInfo) => started.push(server),
    stop: () => stopped++,
  } as unknown as DiscordVoiceSession;
  return {
    started,
    stopped: () => stopped,
    delegate: () => delegate,
    factory: (d: (prompt: string) => Promise<string>) => {
      delegate = d;
      return session;
    },
  };
}

/**
 * A gateway on loopback. The trigger's own start() runs against it: fetch is
 * patched just far enough to answer /gateway/bot with this server's url, and
 * everything after that is the real websocket path.
 */
function fakeGateway() {
  const received: { op: number; d: Record<string, unknown> }[] = [];
  const connected = Promise.withResolvers<WebSocket>();
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onmessage = (raw) => received.push(JSON.parse(raw.data));
    socket.onopen = () => connected.resolve(socket);
    return response;
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/gateway/bot")) {
      return Promise.resolve(Response.json({ url: `ws://127.0.0.1:${server.addr.port}` }));
    }
    return realFetch(url, init);
  }) as typeof fetch;

  return {
    received,
    connected: connected.promise,
    dispatch: (socket: WebSocket, t: string, d: unknown) =>
      socket.send(JSON.stringify({ op: 0, t, d })),
    close: async () => {
      globalThis.fetch = realFetch;
      await server.shutdown();
    },
  };
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const READY = { user: { id: "bot-1", username: "scout" } };
const GUILD = { id: "g1", channels: [{ id: "c-lounge", name: "lounge", type: 2 }] };

/** An emit that records what the agent was asked and answers with a fixed reply. */
function recordingEmit(reply: string) {
  const asked: string[] = [];
  const emit = (event: AgentEvent): Promise<RunResult> => {
    asked.push(event.input);
    return Promise.resolve({
      status: "ok",
      reply,
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      messages: [],
    } as RunResult);
  };
  return { asked, emit };
}

Deno.test("live voice: the trigger joins the named voice channel and opens a session", async () => {
  const voice = fakeSession();
  const gateway = fakeGateway();
  const { asked, emit } = recordingEmit("Three deploys failed.");
  const trigger = new DiscordTrigger({
    token: "t0k",
    voiceChannels: ["lounge"],
    liveVoice: voice.factory,
  });
  await trigger.start(emit);

  const socket = await gateway.connected;
  gateway.dispatch(socket, "READY", READY);
  gateway.dispatch(socket, "GUILD_CREATE", GUILD);

  // Op 4 is the join: the right channel, undeafened so it can hear.
  await until(() => gateway.received.some((m) => m.op === 4), "the voice state update");
  const join = gateway.received.find((m) => m.op === 4)!;
  assertEquals(join.d.guild_id, "g1");
  assertEquals(join.d.channel_id, "c-lounge");
  assertEquals(join.d.self_deaf, false);

  // The voice server arrives in two halves; neither alone starts a session.
  gateway.dispatch(socket, "VOICE_SERVER_UPDATE", {
    guild_id: "g1",
    token: "vtoken",
    endpoint: "eu-1.discord.media:443",
  });
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(voice.started.length, 0, "no session without our own session id");

  gateway.dispatch(socket, "VOICE_STATE_UPDATE", {
    guild_id: "g1",
    user_id: "bot-1",
    session_id: "sess-9",
  });
  gateway.dispatch(socket, "VOICE_SERVER_UPDATE", {
    guild_id: "g1",
    token: "vtoken",
    endpoint: "eu-1.discord.media:443",
  });
  await until(() => voice.started.length === 1, "the voice session");
  assertEquals(voice.started[0], {
    endpoint: "eu-1.discord.media:443",
    token: "vtoken",
    sessionId: "sess-9",
    guildId: "g1",
    userId: "bot-1",
  });

  // The delegate the session was handed is the agent loop: what the voice
  // model asks for, the agent answers.
  const answer = await voice.delegate()!("how did last night's deploys go?");
  assertEquals(asked, ["how did last night's deploys go?"]);
  assertEquals(answer, "Three deploys failed.");

  await trigger.stop();
  assertEquals(voice.stopped(), 1); // stopping the trigger leaves the channel
  await gateway.close();
});

Deno.test("live voice: an empty reply still says something out loud", async () => {
  const voice = fakeSession();
  const gateway = fakeGateway();
  const { emit } = recordingEmit("   "); // the agent finished with nothing to say
  const trigger = new DiscordTrigger({
    token: "t0k",
    voiceChannels: ["lounge"],
    liveVoice: voice.factory,
  });
  await trigger.start(emit);

  const socket = await gateway.connected;
  gateway.dispatch(socket, "READY", READY);
  gateway.dispatch(socket, "VOICE_STATE_UPDATE", {
    guild_id: "g1",
    user_id: "bot-1",
    session_id: "sess-9",
  });
  gateway.dispatch(socket, "VOICE_SERVER_UPDATE", {
    guild_id: "g1",
    token: "vtoken",
    endpoint: "eu-1.discord.media:443",
  });
  await until(() => voice.started.length === 1, "the voice session");

  // Silence would leave the person staring at a bot that stopped talking
  // mid-conversation; the status is at least an answer.
  assertEquals(await voice.delegate()!("anything?"), "(the run ended: ok)");

  await trigger.stop();
  await gateway.close();
});

Deno.test("live voice: a reassigned voice server waits for its new endpoint", async () => {
  const voice = fakeSession();
  const gateway = fakeGateway();
  const { emit } = recordingEmit("ok");
  const trigger = new DiscordTrigger({
    token: "t0k",
    voiceChannels: ["lounge"],
    liveVoice: voice.factory,
  });
  await trigger.start(emit);

  const socket = await gateway.connected;
  gateway.dispatch(socket, "READY", READY);
  gateway.dispatch(socket, "VOICE_STATE_UPDATE", {
    guild_id: "g1",
    user_id: "bot-1",
    session_id: "sess-9",
  });
  // Discord sends a null endpoint while it moves us between voice servers.
  gateway.dispatch(socket, "VOICE_SERVER_UPDATE", {
    guild_id: "g1",
    token: "vtoken",
    endpoint: null,
  });
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(voice.started.length, 0);

  gateway.dispatch(socket, "VOICE_SERVER_UPDATE", {
    guild_id: "g1",
    token: "vtoken2",
    endpoint: "eu-2.discord.media:443",
  });
  await until(() => voice.started.length === 1, "the reassigned session");
  assertEquals(voice.started[0].token, "vtoken2");

  await trigger.stop();
  await gateway.close();
});

Deno.test("live voice: without a voice_channels filter the bot never joins", async () => {
  const voice = fakeSession();
  const gateway = fakeGateway();
  const { emit } = recordingEmit("ok");
  const trigger = new DiscordTrigger({ token: "t0k" }); // no voiceChannels, no liveVoice
  await trigger.start(emit);

  const socket = await gateway.connected;
  gateway.dispatch(socket, "READY", READY);
  gateway.dispatch(socket, "GUILD_CREATE", GUILD);
  await new Promise((r) => setTimeout(r, 50));

  assert(!gateway.received.some((m) => m.op === 4), "no join without a voice_channels filter");
  assertEquals(voice.started.length, 0);

  await trigger.stop();
  await gateway.close();
});
