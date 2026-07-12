import { logError, logInfo } from "@looped/core";
import type { LiveVoiceConfig } from "@looped/core";
import { CHANNELS, FRAME_SAMPLES, OpusCodec } from "./opus.ts";
import { discordToRealtime, realtimeToDiscord } from "./pcm.ts";
import {
  ENCRYPTION_MODE,
  importVoiceKey,
  ipDiscoveryRequest,
  openRtp,
  parseIpDiscovery,
  parseRtp,
  rtpHeader,
  sealRtp,
  SILENCE_FRAME,
} from "./rtp.ts";
import { RealtimeSession } from "./realtime.ts";

// One live conversation in one Discord voice channel: the voice websocket for
// handshake and control, a UDP socket for media, and a realtime session on the
// other side. Audio decoded here goes up to the model; audio the model speaks
// comes back down as Opus on the 20 ms clock Discord expects (plan 15).
//
// The realtime session opens lazily on first speech and closes after
// idle_seconds of silence — it bills by the audio minute, and a bot sitting in
// an empty channel should cost nothing.

/** 20 ms per frame, the pace Discord's clock runs at. */
const FRAME_MS = 20;

/** How much spoken audio may queue before we drop the oldest — about a second. */
const MAX_QUEUED_FRAMES = 50;

/** What the trigger hands a voice session once the gateway has answered. */
export interface VoiceServerInfo {
  /** Voice websocket endpoint, e.g. "eu-central1234.discord.media:443". */
  endpoint: string;
  /** The voice connection's token, from VOICE_SERVER_UPDATE. */
  token: string;
  /** The gateway session id, from our own VOICE_STATE_UPDATE. */
  sessionId: string;
  /** The guild whose channel we joined. */
  guildId: string;
  /** The bot's user id. */
  userId: string;
}

/** Options for {@linkcode DiscordVoiceSession}. */
export interface DiscordVoiceSessionOptions {
  /** The live block: model, voice, idle budget. */
  config: LiveVoiceConfig;
  /** Realtime API key, resolved from its env reference. */
  apiKey: string;
  /** The agent's purpose, so the voice model knows whose mouth it is. */
  instructions: string;
  /** Runs a prompt through the agent loop. */
  delegate: (prompt: string) => Promise<string>;
  /** Injectable for tests. */
  connectWs?: (url: string) => WebSocket;
}

/**
 * A live voice conversation in one channel. {@linkcode start} it with the
 * voice server the gateway named, and it holds the connection until
 * {@linkcode stop}: handshake, media, and the realtime session behind it.
 */
export class DiscordVoiceSession {
  #opts: DiscordVoiceSessionOptions;
  #ws?: WebSocket;
  #udp?: Deno.DatagramConn;
  #heartbeat?: ReturnType<typeof setInterval>;
  #ticker?: ReturnType<typeof setInterval>;
  #idleTimer?: ReturnType<typeof setTimeout>;
  #stopped = false;

  #codec = new OpusCodec();
  #key?: CryptoKey;
  #ssrc = 0;
  #remote?: { hostname: string; port: number };
  #seqAck = -1;

  // Our side of the RTP clock: sequence, timestamp and the AEAD nonce all
  // advance one step per frame we send.
  #seq = 0;
  #timestamp = 0;
  #nonce = 0;
  #speaking = false;
  #silenceLeft = 0;

  /** Spoken audio waiting for its slot on the 20 ms clock. */
  #outbound: Int16Array[] = [];
  #session?: RealtimeSession;

  /** Create the session; nothing connects until {@linkcode start}. */
  constructor(opts: DiscordVoiceSessionOptions) {
    this.#opts = opts;
  }

  #send(op: number, d: unknown) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ op, d }));
  }

  /** Connect to the voice server and hold the conversation until stopped. */
  start(server: VoiceServerInfo): void {
    const url = `wss://${server.endpoint.split(":")[0]}/?v=8`;
    const ws = (this.#opts.connectWs ?? ((u) => new WebSocket(u)))(url);
    this.#ws = ws;

    ws.onopen = () => {
      this.#send(0, { // IDENTIFY
        server_id: server.guildId,
        user_id: server.userId,
        session_id: server.sessionId,
        token: server.token,
        // DAVE (end-to-end encryption) is not implemented: we ask for the
        // transport-encrypted path, which voice servers still accept. Plan 15
        // tracks this as the feature's shelf life.
        max_dave_protocol_version: 0,
      });
    };

    ws.onmessage = async (raw) => {
      const payload = JSON.parse(raw.data);
      if (typeof payload.seq === "number") this.#seqAck = payload.seq;
      switch (payload.op) {
        case 8: // HELLO
          clearInterval(this.#heartbeat);
          this.#heartbeat = setInterval(
            () => this.#send(3, { t: Date.now(), seq_ack: this.#seqAck }),
            payload.d.heartbeat_interval,
          );
          break;
        case 2: // READY: our ssrc, and where to send media
          this.#ssrc = payload.d.ssrc;
          await this.#openUdp(payload.d.ip, payload.d.port);
          break;
        case 4: // SESSION DESCRIPTION: the media key
          this.#key = await importVoiceKey(payload.d.secret_key);
          this.#startClock();
          logInfo("live voice: connected to the voice channel");
          break;
      }
    };

    ws.onerror = () => logError("live voice: voice websocket error");
    ws.onclose = () => {
      if (!this.#stopped) logInfo("live voice: voice websocket closed");
      this.#teardownMedia();
    };
  }

  /**
   * Open the media socket, discover the address the voice server sees us at,
   * and select the protocol. Discord answers the discovery packet on the same
   * socket the media then flows over.
   */
  async #openUdp(ip: string, port: number) {
    this.#udp = Deno.listenDatagram({ transport: "udp", hostname: "0.0.0.0", port: 0 });
    this.#remote = { hostname: ip, port };
    const addr: Deno.NetAddr = { transport: "udp", hostname: ip, port };

    await this.#udp.send(ipDiscoveryRequest(this.#ssrc), addr);
    const [response] = await this.#udp.receive();
    const discovered = parseIpDiscovery(response);
    if (!discovered) {
      logError("live voice: IP discovery failed");
      return;
    }

    this.#send(1, { // SELECT PROTOCOL
      protocol: "udp",
      data: { address: discovered.address, port: discovered.port, mode: ENCRYPTION_MODE },
    });
    this.#receiveLoop();
  }

  /** Everything the channel says, decoded and pushed to the model. */
  async #receiveLoop() {
    while (!this.#stopped && this.#udp) {
      let packet: Uint8Array<ArrayBuffer>;
      try {
        [packet] = await this.#udp.receive() as [Uint8Array<ArrayBuffer>, Deno.Addr];
      } catch {
        return; // the socket closed under us
      }
      if (!this.#key) continue;
      const info = parseRtp(packet);
      // Our own audio echoes back on this socket; so does RTCP.
      if (!info || info.ssrc === this.#ssrc) continue;
      const opus = await openRtp(this.#key, packet, info);
      if (!opus || !opus.length) continue;
      // A silence frame is Discord saying "nothing here" — it decodes to
      // nothing useful and would only feed the model its own dead air.
      if (opus.length === SILENCE_FRAME.length) continue;

      try {
        const pcm = this.#codec.decode(opus);
        const session = await this.#liveSession();
        session.appendAudio(discordToRealtime(pcm));
        this.#touchIdle();
      } catch (err) {
        logError(`live voice: could not decode a frame: ${(err as Error).message}`);
      }
    }
  }

  /**
   * The realtime session, opened on first speech. Keeping it lazy is what
   * makes an idle bot free: the socket only exists while someone is talking.
   */
  async #liveSession(): Promise<RealtimeSession> {
    if (this.#session?.live) return this.#session;
    const session = new RealtimeSession({
      config: this.#opts.config,
      apiKey: this.#opts.apiKey,
      instructions: this.#opts.instructions,
      delegate: this.#opts.delegate,
      onAudio: (pcm) => this.#speak(pcm),
      // Barge-in: the human started talking, so drop the rest of our turn.
      onInterrupt: () => (this.#outbound.length = 0),
    });
    this.#session = session;
    await session.open();
    return session;
  }

  /** Queue spoken audio, in whole 20 ms frames of 48 kHz stereo. */
  #speak(pcm24kMono: Uint8Array) {
    const stereo = realtimeToDiscord(pcm24kMono);
    const frameSamples = FRAME_SAMPLES * CHANNELS;
    // The model's deltas don't arrive on frame boundaries; carry the remainder
    // into the next one rather than clipping it.
    const carry = this.#outbound.at(-1);
    const pending = carry && carry.length < frameSamples ? this.#outbound.pop()! : undefined;
    const merged = pending ? new Int16Array(pending.length + stereo.length) : stereo;
    if (pending) {
      merged.set(pending);
      merged.set(stereo, pending.length);
    }
    for (let at = 0; at < merged.length; at += frameSamples) {
      this.#outbound.push(merged.subarray(at, Math.min(at + frameSamples, merged.length)));
    }
    // A backlog means we are further behind than the conversation can use.
    if (this.#outbound.length > MAX_QUEUED_FRAMES) {
      this.#outbound.splice(0, this.#outbound.length - MAX_QUEUED_FRAMES);
    }
    this.#touchIdle();
  }

  /** The 20 ms clock: one frame out per tick, silence when there's nothing to say. */
  #startClock() {
    clearInterval(this.#ticker);
    this.#ticker = setInterval(() => this.#tick(), FRAME_MS);
  }

  async #tick() {
    if (!this.#key || !this.#udp || !this.#remote) return;
    const frame = this.#outbound.shift();

    if (!frame) {
      // Five silence frames close a turn, then we go quiet on the wire.
      if (this.#speaking) {
        this.#speaking = false;
        this.#silenceLeft = 5;
        this.#send(5, { speaking: 0, delay: 0, ssrc: this.#ssrc });
      }
      if (this.#silenceLeft > 0) {
        this.#silenceLeft--;
        await this.#sendFrame(SILENCE_FRAME as Uint8Array<ArrayBuffer>);
      }
      return;
    }

    if (!this.#speaking) {
      this.#speaking = true;
      this.#silenceLeft = 0;
      this.#send(5, { speaking: 1, delay: 0, ssrc: this.#ssrc });
    }

    // A short final frame still has to be a whole frame on the wire; the
    // remainder is silence.
    let full = frame;
    if (frame.length < FRAME_SAMPLES * CHANNELS) {
      full = new Int16Array(FRAME_SAMPLES * CHANNELS);
      full.set(frame);
    }
    await this.#sendFrame(this.#codec.encode(full));
  }

  async #sendFrame(opus: Uint8Array<ArrayBuffer>) {
    const header = rtpHeader(this.#seq, this.#timestamp, this.#ssrc);
    this.#seq = (this.#seq + 1) & 0xffff;
    this.#timestamp = (this.#timestamp + FRAME_SAMPLES) >>> 0;
    this.#nonce = (this.#nonce + 1) >>> 0;
    try {
      const packet = await sealRtp(this.#key!, header, opus, this.#nonce);
      await this.#udp!.send(packet, {
        transport: "udp",
        hostname: this.#remote!.hostname,
        port: this.#remote!.port,
      });
    } catch (err) {
      if (!this.#stopped) logError(`live voice: send failed: ${(err as Error).message}`);
    }
  }

  /** Silence for idle_seconds closes the realtime session; speech reopens it. */
  #touchIdle() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      if (this.#session) {
        logInfo("live voice: idle, closing the realtime session");
        this.#session.close();
        this.#session = undefined;
      }
    }, this.#opts.config.idle_seconds * 1_000);
  }

  #teardownMedia() {
    clearInterval(this.#heartbeat);
    clearInterval(this.#ticker);
    clearTimeout(this.#idleTimer);
    this.#session?.close();
    this.#session = undefined;
    try {
      this.#udp?.close();
    } catch {
      // already closed
    }
    this.#udp = undefined;
  }

  /** Leave the channel and close everything behind it. */
  stop(): void {
    this.#stopped = true;
    this.#teardownMedia();
    this.#ws?.close();
    this.#codec.destroy();
  }
}
