import { assert, assertEquals } from "@std/assert";
import { DELEGATE_TOOL, RealtimeSession } from "./realtime.ts";
import type { LiveVoiceConfig } from "@looped/core";

const CONFIG: LiveVoiceConfig = {
  provider: "openai",
  model: "gpt-realtime-2.1",
  voice: "marin",
  idle_seconds: 60,
};

/**
 * A stand-in for the provider: a real websocket server on loopback, so the
 * session's own socket code runs unmodified. Hands back the events it was
 * sent, and lets a test push events down the wire.
 */
function fakeProvider() {
  const received: Record<string, unknown>[] = [];
  const connected = Promise.withResolvers<WebSocket>();
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req, { protocol: "realtime" });
    socket.onmessage = (raw) => received.push(JSON.parse(raw.data));
    socket.onopen = () => connected.resolve(socket);
    return response;
  });
  const url = `ws://127.0.0.1:${server.addr.port}`;
  return {
    received,
    connected: connected.promise,
    connect: (_url: string, protocols: string[]) => new WebSocket(url, protocols),
    /** The subprotocols the session offered — that's where the API key rides. */
    close: async () => await server.shutdown(),
  };
}

/** Wait until `check` holds, so a test never sleeps on a fixed timer. */
async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

Deno.test("realtime: the session configures itself with audio, VAD and the delegate tool", async () => {
  const provider = fakeProvider();
  const session = new RealtimeSession({
    config: CONFIG,
    apiKey: "sk-test",
    instructions: "You are a helpful agent.",
    delegate: () => Promise.resolve("unused"),
    onAudio: () => {},
    onInterrupt: () => {},
    connect: provider.connect,
  });
  await session.open();
  await until(() => provider.received.length > 0, "session.update");

  const update = provider.received[0] as {
    type: string;
    session: Record<string, Record<string, Record<string, unknown>>>;
  };
  assertEquals(update.type, "session.update");
  assertEquals(update.session.type, "realtime" as unknown);
  assertEquals(update.session.instructions, "You are a helpful agent." as unknown);
  // Both directions speak the 24kHz PCM the bridge resamples to.
  assertEquals(update.session.audio.input.format, { type: "audio/pcm", rate: 24_000 });
  assertEquals(update.session.audio.output.format, { type: "audio/pcm", rate: 24_000 });
  assertEquals(update.session.audio.output.voice, "marin" as unknown);
  // Server VAD is what makes barge-in the model's job rather than ours.
  assertEquals(update.session.audio.input.turn_detection, {
    type: "server_vad",
    create_response: true,
    interrupt_response: true,
  });
  // Exactly one tool: the door back into the agent loop.
  const tools = update.session.tools as unknown as { name: string }[];
  assertEquals(tools.length, 1);
  assertEquals(tools[0].name, DELEGATE_TOOL);

  session.close();
  await provider.close();
});

Deno.test("realtime: microphone audio goes up, spoken audio comes back down", async () => {
  const provider = fakeProvider();
  const spoken: Uint8Array[] = [];
  const session = new RealtimeSession({
    config: CONFIG,
    apiKey: "sk-test",
    instructions: "purpose",
    delegate: () => Promise.resolve("unused"),
    onAudio: (pcm) => spoken.push(pcm),
    onInterrupt: () => {},
    connect: provider.connect,
  });
  await session.open();
  const socket = await provider.connected;

  session.appendAudio(new Uint8Array([1, 2, 3, 4]));
  session.appendAudio(new Uint8Array()); // empty frames are not worth a packet
  await until(() => provider.received.length > 1, "the audio append");
  const append = provider.received[1] as { type: string; audio: string };
  assertEquals(append.type, "input_audio_buffer.append");
  assertEquals(atob(append.audio), "\x01\x02\x03\x04");
  assertEquals(provider.received.length, 2); // the empty frame sent nothing

  socket.send(JSON.stringify({ type: "response.output_audio.delta", delta: btoa("hello") }));
  await until(() => spoken.length > 0, "the spoken audio");
  assertEquals(new TextDecoder().decode(spoken[0]), "hello");

  session.close();
  await provider.close();
});

Deno.test("realtime: speech from the human interrupts what the agent is saying", async () => {
  const provider = fakeProvider();
  let interrupted = 0;
  const session = new RealtimeSession({
    config: CONFIG,
    apiKey: "sk-test",
    instructions: "purpose",
    delegate: () => Promise.resolve("unused"),
    onAudio: () => {},
    onInterrupt: () => interrupted++,
    connect: provider.connect,
  });
  await session.open();
  const socket = await provider.connected;

  socket.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  await until(() => interrupted === 1, "the interrupt");

  session.close();
  await provider.close();
});

Deno.test("realtime: a tool call runs the agent and hands the answer back", async () => {
  const provider = fakeProvider();
  const asked: string[] = [];
  const session = new RealtimeSession({
    config: CONFIG,
    apiKey: "sk-test",
    instructions: "purpose",
    delegate: (prompt) => {
      asked.push(prompt);
      return Promise.resolve("Three deploys failed overnight.");
    },
    onAudio: () => {},
    onInterrupt: () => {},
    connect: provider.connect,
  });
  await session.open();
  const socket = await provider.connected;

  socket.send(JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-1",
    arguments: JSON.stringify({ request: "how did last night's deploys go?" }),
  }));
  await until(() => provider.received.length >= 3, "the tool result");

  assertEquals(asked, ["how did last night's deploys go?"]);
  const output = provider.received[1] as { type: string; item: Record<string, string> };
  assertEquals(output.type, "conversation.item.create");
  assertEquals(output.item.type, "function_call_output");
  assertEquals(output.item.call_id, "call-1");
  assertEquals(output.item.output, "Three deploys failed overnight.");
  // …and the model is asked to speak the answer.
  assertEquals((provider.received[2] as { type: string }).type, "response.create");

  session.close();
  await provider.close();
});

Deno.test("realtime: a failed run is spoken, not swallowed", async () => {
  const provider = fakeProvider();
  const session = new RealtimeSession({
    config: CONFIG,
    apiKey: "sk-test",
    instructions: "purpose",
    delegate: () => Promise.reject(new Error("the database is down")),
    onAudio: () => {},
    onInterrupt: () => {},
    connect: provider.connect,
  });
  await session.open();
  const socket = await provider.connected;

  socket.send(JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-2",
    arguments: JSON.stringify({ request: "check the database" }),
  }));
  await until(() => provider.received.length >= 3, "the failure result");

  const output = provider.received[1] as { type: string; item: Record<string, string> };
  assert(output.item.output.includes("the database is down"));

  session.close();
  await provider.close();
});
