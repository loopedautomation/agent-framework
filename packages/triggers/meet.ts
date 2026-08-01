import { logInfo } from "@looped/core";
import type { AgentEvent, HandleOptions, ImageContent, RunResult, Trigger } from "@looped/core";
import { MAX_IMAGES, timingSafeEqual, validImages } from "./ws_session.ts";

/**
 * A meeting, over the same WebSocket transport as {@linkcode TtyTrigger} and
 * with the opposite contract.
 *
 * `tty` documents itself as "each connection is a conversation", which is
 * right for a terminal: a new window should be a fresh start. A meeting is the
 * other way round. The meeting is the conversation, and connections come and
 * go inside it while a laptop sleeps or a bridge reconnects. Overloading one
 * trigger with both meanings is what left the meeting id as an optional query
 * parameter whose absence silently orphaned a meeting's history.
 *
 * So the meeting id is the first thing said, not a parameter that might be
 * missing, and the two events a terminal has no concept of get frames of their
 * own: who is in the room, and when the room closes. The last one is the
 * reason this exists. A closed socket is ambiguous between a dropped
 * connection and a finished meeting, and the agent can only write a useful
 * summary if it is told which one happened while it still has the context.
 */

/** Options for {@linkcode MeetTrigger}. */
export interface MeetTriggerOptions {
  /** URL path that accepts the WebSocket upgrade. */
  path: string;
  /** TCP port to listen on. */
  port: number;
  /** The expected bearer token (already resolved from token_env). */
  token: string;
  /** The operator's handle for this agent, announced in the hello frame. */
  handle: string;
  /** The agent's self-chosen identity name, announced in the hello frame. */
  name: string;
  /** The agent's job description, announced in the hello frame when set. */
  description?: string;
  /**
   * What the agent is asked when a meeting ends, producing the record of it.
   * Undefined means an `end` frame closes the meeting without spending a call:
   * a summary is a model call per meeting and not every agent wants one.
   */
  summarizeOnEnd?: string;
  /** Injectable for tests: 0 picks an ephemeral port. */
  onListen?: (addr: { port: number }) => void;
}

/** A frame the server sends to a connected meeting. */
export type MeetServerFrame =
  /** Sent once the `join` handshake is accepted. */
  | {
    type: "hello";
    handle: string;
    name: string;
    description?: string;
    meeting_id: string;
    /** Whether history from an earlier connection to this meeting was found. */
    resumed: boolean;
  }
  | { type: "step"; n: number }
  | { type: "assistant"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; content: string; durationMs: number }
  | { type: "compaction"; messageCount: number }
  | { type: "result"; status: string; reply: string; steps: number }
  /** The meeting's closing summary, when `summarize_on_end` is configured. */
  | { type: "summary"; text: string }
  | { type: "error"; error: string };

/** A frame a meeting sends to the agent. */
export type MeetClientFrame =
  /**
   * The handshake, and also the resume path. Required before anything else:
   * without a meeting id there is no stable conversation and the meeting's
   * history would be written somewhere nothing can reach again.
   */
  | { type: "join"; meeting_id: string; participants?: string[] }
  /** Someone entered or left. Recorded, and does not start a run by itself. */
  | { type: "participant"; name: string; action: "joined" | "left" }
  | { type: "input"; text: string; images?: { mediaType: string; data: string }[] }
  | { type: "cancel" }
  /**
   * The meeting is over. Distinct from the socket closing, which is only a
   * dropped connection. This is what lets the agent write its record while it
   * still has the conversation in context.
   */
  | { type: "end"; reason?: string };

/** Interactive meetings over WebSocket, keyed by meeting id. */
export class MeetTrigger implements Trigger {
  /** Trigger name, used as the event's `trigger` field. */
  readonly name = "meet";
  #opts: MeetTriggerOptions;
  #server?: Deno.HttpServer;
  /** Open sockets by conversation key, for proactive delivery. */
  #sockets = new Map<string, Set<WebSocket>>();
  /** Meetings that have sent `end`, so a late reconnect does not reopen one. */
  #ended = new Set<string>();

  /** Create the trigger; no server runs until {@linkcode start}. */
  constructor(opts: MeetTriggerOptions) {
    this.#opts = opts;
  }

  #authorized(req: Request): { ok: boolean; protocol?: string } {
    const { token } = this.#opts;
    const header = req.headers.get("authorization");
    if (header) return { ok: timingSafeEqual(header, `Bearer ${token}`) };
    const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
      .split(",").map((p) => p.trim());
    const bearer = protocols.find((p) => p.startsWith("bearer."));
    if (bearer) return { ok: timingSafeEqual(bearer, `bearer.${token}`), protocol: bearer };
    return { ok: false };
  }

  /** Start the server; each authorized upgrade waits for a `join` frame. */
  start(
    emit: (event: AgentEvent, opts?: HandleOptions) => Promise<RunResult>,
    stop: (conversationKey: string) => boolean,
  ): Promise<void> {
    const { path, port } = this.#opts;
    this.#server = Deno.serve({
      port,
      onListen: this.#opts.onListen ?? ((addr) => logInfo(`meet on :${addr.port}${path}`)),
    }, (req) => {
      const url = new URL(req.url);
      if (url.pathname !== path) return new Response("not found", { status: 404 });
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "websocket upgrade required" }, { status: 426 });
      }
      const auth = this.#authorized(req);
      if (!auth.ok) return Response.json({ error: "unauthorized" }, { status: 401 });
      const { socket, response } = Deno.upgradeWebSocket(
        req,
        auth.protocol ? { protocol: auth.protocol } : {},
      );
      this.#attach(socket, emit, stop);
      return response;
    });
    return Promise.resolve();
  }

  #attach(
    socket: WebSocket,
    emit: (event: AgentEvent, opts?: HandleOptions) => Promise<RunResult>,
    stop: (conversationKey: string) => boolean,
  ) {
    let meetingId: string | undefined;
    let conversationKey: string | undefined;
    let running = false;

    const send = (frame: MeetServerFrame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };

    socket.onclose = () => {
      if (conversationKey === undefined) return;
      const set = this.#sockets.get(conversationKey);
      set?.delete(socket);
      if (set?.size === 0) this.#sockets.delete(conversationKey);
    };

    /** Run one turn and stream it back. Shared by input and the closing summary. */
    const run = async (input: string, images?: ImageContent[]): Promise<RunResult | undefined> => {
      if (conversationKey === undefined) return undefined;
      try {
        return await emit(
          {
            id: crypto.randomUUID(),
            trigger: this.name,
            input,
            images: images?.length ? images : undefined,
            conversationKey,
          },
          {
            onEvent: (e) => {
              if (e.type === "compaction") {
                send({ type: "compaction", messageCount: e.messageCount });
              } else send(e);
            },
          },
        );
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
    };

    socket.onmessage = async (msg) => {
      let frame: MeetClientFrame;
      try {
        frame = JSON.parse(String(msg.data));
      } catch {
        return send({ type: "error", error: "frames must be JSON" });
      }

      // The handshake gates everything. A connection that never names its
      // meeting has no conversation to belong to, and guessing one is exactly
      // the failure this trigger exists to remove.
      if (frame.type === "join") {
        if (typeof frame.meeting_id !== "string" || !frame.meeting_id.trim()) {
          return send({ type: "error", error: 'join requires a non-empty "meeting_id"' });
        }
        if (meetingId !== undefined) {
          return send({ type: "error", error: "already joined" });
        }
        meetingId = frame.meeting_id.trim();
        conversationKey = `meet:${meetingId}`;
        let set = this.#sockets.get(conversationKey);
        if (!set) this.#sockets.set(conversationKey, set = new Set());
        // A second socket on the same meeting is a reconnect or a second
        // participant's client, not a second conversation.
        const resumed = set.size > 0 || this.#ended.has(meetingId);
        set.add(socket);
        const { handle, name, description } = this.#opts;
        return send({
          type: "hello",
          handle,
          name,
          ...(description ? { description } : {}),
          meeting_id: meetingId,
          resumed,
        });
      }

      if (conversationKey === undefined) {
        return send({ type: "error", error: 'send {type: "join", meeting_id} first' });
      }

      if (frame.type === "cancel") {
        stop(conversationKey);
        return;
      }

      if (frame.type === "participant") {
        if (typeof frame.name !== "string" || !["joined", "left"].includes(frame.action)) {
          return send({ type: "error", error: 'participant requires "name" and joined|left' });
        }
        // Context the agent should have without a turn being spent on it. A
        // busy room would otherwise start a run per arrival.
        logInfo(`meet ${meetingId}: ${frame.name} ${frame.action}`);
        return;
      }

      if (frame.type === "end") {
        // A bridge can race itself into sending this twice (a reconnect
        // delivering an end that was already in flight). The second one must
        // not spend a second summary call on a meeting that already has one.
        if (this.#ended.has(meetingId!)) {
          socket.close(1000, "meeting ended");
          return;
        }
        this.#ended.add(meetingId!);
        const prompt = this.#opts.summarizeOnEnd;
        // Without a configured prompt an ending costs nothing: not every
        // agent wants to spend a model call on every meeting.
        if (prompt) {
          if (running) return send({ type: "error", error: "a run is already in progress" });
          running = true;
          try {
            const result = await run(prompt);
            if (result) send({ type: "summary", text: result.reply });
          } finally {
            running = false;
          }
        }
        socket.close(1000, "meeting ended");
        return;
      }

      if (frame.type !== "input" || typeof frame.text !== "string" || !frame.text.trim()) {
        return send({ type: "error", error: 'expected {type: "input", text: "..."}' });
      }
      if (!validImages(frame.images)) {
        return send({
          type: "error",
          error: `images must be at most ${MAX_IMAGES} of ` +
            `{mediaType: png|jpeg|gif|webp, data: base64}`,
        });
      }
      if (running) return send({ type: "error", error: "a run is already in progress" });
      running = true;
      try {
        const result = await run(frame.text, frame.images);
        if (result) {
          send({ type: "result", status: result.status, reply: result.reply, steps: result.steps });
        }
      } finally {
        running = false;
      }
    };
  }

  /** Push a scheduled message into any open client on that meeting. */
  deliver(conversationKey: string, text: string): Promise<boolean> {
    const set = this.#sockets.get(conversationKey);
    if (!set?.size) return Promise.resolve(false);
    const frame = JSON.stringify({ type: "result", status: "ok", reply: text, steps: 0 });
    for (const socket of set) {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    }
    return Promise.resolve(true);
  }

  /** Close every meeting and shut down the server. */
  async stop(): Promise<void> {
    for (const set of this.#sockets.values()) {
      for (const socket of set) socket.close(1001, "agent shutting down");
    }
    this.#sockets.clear();
    await this.#server?.shutdown();
  }
}
