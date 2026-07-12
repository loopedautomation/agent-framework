import { logError, logInfo } from "@looped/core";
import type { LiveVoiceConfig } from "@looped/core";

// A realtime speech-to-speech session, over the one websocket the provider
// keeps open for the whole conversation. The model here is the interaction
// layer: it hears, it talks, it decides when to speak. Everything that needs
// tools, knowledge or judgment it hands to the agent through one function
// call, and the agent loop does the work with its own permissions and audit
// trail (plan 15). No library — the protocol is JSON events over a socket.

/** The audio format both directions of the session speak: 24 kHz mono PCM16. */
export const REALTIME_SAMPLE_RATE = 24_000;

/** The tool the realtime model calls to put the agent to work. */
export const DELEGATE_TOOL = "ask_agent";

const DEFAULT_HOST = "wss://api.openai.com/v1/realtime";

/** What a live session needs from the world around it. */
export interface RealtimeSessionOptions {
  /** The live block from the agent's config: model, voice, budget. */
  config: LiveVoiceConfig;
  /** API key, already resolved from its env reference. */
  apiKey: string;
  /** The agent's purpose, so the voice model knows whose mouth it is. */
  instructions: string;
  /** Runs the prompt through the agent loop and resolves with the reply. */
  delegate: (prompt: string) => Promise<string>;
  /** Speak these 24 kHz mono PCM16 bytes into the channel. */
  onAudio: (pcm: Uint8Array) => void;
  /** The model started a new response — cut off whatever is still playing. */
  onInterrupt: () => void;
  /** Injectable for tests; defaults to the global WebSocket. */
  connect?: (url: string, protocols: string[]) => WebSocket;
}

/** Base64 of a byte array, chunked so a long turn cannot blow the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * One realtime conversation. Open it, push microphone audio in, and it
 * pushes spoken audio back out through `onAudio` — turn-taking, barge-in and
 * backchannels are the model's business, not ours.
 */
export class RealtimeSession {
  #opts: RealtimeSessionOptions;
  #ws?: WebSocket;
  #closed = false;
  #ready = Promise.withResolvers<void>();

  /** Create the session; nothing connects until {@linkcode open}. */
  constructor(opts: RealtimeSessionOptions) {
    this.#opts = opts;
  }

  /** Whether the socket is up and the session configured. */
  get live(): boolean {
    return !this.#closed && this.#ws?.readyState === WebSocket.OPEN;
  }

  #send(event: Record<string, unknown>) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(event));
  }

  /**
   * Connect and configure the session. Resolves once the provider has
   * accepted it, so the first audio frame never races the handshake.
   */
  async open(): Promise<void> {
    const { config, apiKey, connect } = this.#opts;
    const url = `${DEFAULT_HOST}?model=${encodeURIComponent(config.model)}`;
    // The websocket API carries no headers, so the key rides the subprotocol
    // — the provider's documented path for a non-browser client.
    const ws = (connect ?? ((u, p) => new WebSocket(u, p)))(url, [
      "realtime",
      `openai-insecure-api-key.${apiKey}`,
    ]);
    this.#ws = ws;

    ws.onopen = () => {
      this.#send({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: this.#opts.instructions,
          audio: {
            input: {
              format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
              // Server-side VAD is what makes this feel like a conversation:
              // the model decides when a turn ended and interrupts itself
              // when the human starts talking again.
              turn_detection: {
                type: "server_vad",
                create_response: true,
                interrupt_response: true,
              },
            },
            output: {
              format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
              voice: config.voice,
            },
          },
          tools: [{
            type: "function",
            name: DELEGATE_TOOL,
            description:
              "Ask the agent to do something or answer something. It has this agent's tools, " +
              "memory and permissions. Use it for anything beyond small talk: questions about " +
              "systems, data or state, and every request to take an action. Say a few words " +
              "first so the person knows you are working on it.",
            parameters: {
              type: "object",
              properties: {
                request: {
                  type: "string",
                  description: "What to ask the agent, in full sentences and self-contained.",
                },
              },
              required: ["request"],
            },
          }],
        },
      });
      this.#ready.resolve();
    };

    ws.onmessage = (raw) => this.#handle(JSON.parse(raw.data));
    ws.onerror = () => logError("realtime: websocket error");
    ws.onclose = () => {
      this.#closed = true;
      this.#ready.resolve(); // never strand a caller waiting on a dead socket
    };

    await this.#ready.promise;
  }

  #handle(event: { type: string; [key: string]: unknown }) {
    switch (event.type) {
      case "session.updated":
        logInfo(`live voice: realtime session ready (${this.#opts.config.model})`);
        break;
      case "response.output_audio.delta":
        this.#opts.onAudio(fromBase64(event.delta as string));
        break;
      case "input_audio_buffer.speech_started":
        // The human started talking over us: drop what we were about to say.
        this.#opts.onInterrupt();
        break;
      case "response.function_call_arguments.done":
        this.#delegate({
          call_id: String(event.call_id),
          arguments: String(event.arguments),
        });
        break;
      case "error":
        logError(`realtime: ${JSON.stringify(event.error)}`);
        break;
    }
  }

  /**
   * The model asked the agent for something. Run it, hand the answer back as
   * the tool's result, and ask for a spoken response. A failed run comes back
   * as text too — the model can tell the person what broke.
   */
  async #delegate(call: { call_id: string; arguments: string }) {
    let output: string;
    try {
      const { request } = JSON.parse(call.arguments) as { request: string };
      logInfo(`live voice: delegating to the agent — ${request}`);
      output = await this.#opts.delegate(request);
    } catch (err) {
      output = `The agent could not answer: ${(err as Error).message}`;
    }
    this.#send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: call.call_id, output },
    });
    this.#send({ type: "response.create" });
  }

  /** Push 24 kHz mono PCM16 audio from the channel into the session. */
  appendAudio(pcm: Uint8Array) {
    if (!pcm.length) return;
    this.#send({ type: "input_audio_buffer.append", audio: toBase64(pcm) });
  }

  /** Close the socket; a session reopens on the next voice activity. */
  close() {
    this.#closed = true;
    this.#ws?.close();
  }
}
