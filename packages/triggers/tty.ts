import { logInfo, timingSafeEqual } from "@looped/core";
import type { AgentEvent, HandleOptions, ImageContent, RunResult, Trigger } from "@looped/core";

/** Options for {@linkcode TtyTrigger}. */
export interface TtyTriggerOptions {
  /** URL path that accepts the WebSocket upgrade. */
  path: string;
  /** TCP port to listen on. */
  port: number;
  /** The expected bearer token (already resolved from token_env). */
  token: string;
  /** The operator's handle for this agent, announced in the hello frame. */
  handle: string;
  /**
   * The agent's self-chosen identity name (the same value /healthz serves),
   * announced in the hello frame so clients can label it by name, not handle.
   * Falls back to the handle before the naming ritual has run.
   */
  name: string;
  /** The agent's job description, announced in the hello frame when set. */
  description?: string;
  /** Injectable for tests: 0 picks an ephemeral port. */
  onListen?: (addr: { port: number }) => void;
}

/** A frame the server sends to a connected terminal. */
export type TtyServerFrame =
  /**
   * Sent once on connect. `name` is the agent's self-chosen identity (handle
   * before the naming ritual); `description` its job. Older clients ignore the
   * added fields, so the frame stays backwards compatible.
   */
  | { type: "hello"; handle: string; name: string; description?: string; conversation_id: string }
  /** The run's inner-loop progress, mirrored from RunEvent. */
  | { type: "step"; n: number }
  | { type: "assistant"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; content: string; durationMs: number }
  | { type: "compaction"; messageCount: number }
  /** The run finished; the terminal can accept the next input. */
  | { type: "result"; status: RunResult["status"]; reply: string; steps: number }
  /** A proactive message (agent-created schedules) for this conversation. */
  | { type: "message"; text: string }
  | { type: "error"; error: string };

/** A frame a terminal sends to the server. */
export type TtyClientFrame =
  | {
    type: "input";
    text: string;
    /** Optional images for the turn (e.g. a meeting screenshare frame). */
    images?: { mediaType: string; data: string }[];
  }
  /**
   * Abort the run in flight on this socket. Accepted while a run is executing
   * (it's the one frame that bypasses the one-run-at-a-time guard); a no-op
   * when nothing is running. The aborted run halts at its next step boundary
   * and sends its own `{type: "result", status: "aborted"}` terminal frame.
   */
  | { type: "cancel" };

/** Image formats every provider dialect accepts (mirrors ImageContent). */
const TTY_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Guardrails: a screen frame, not a photo dump. */
const TTY_MAX_IMAGES = 4;
const TTY_MAX_IMAGE_BYTES = 8 * 1024 * 1024; // of base64 text, ~6MB of pixels

function validImages(
  images: unknown,
): images is { mediaType: ImageContent["mediaType"]; data: string }[] {
  if (images === undefined) return true;
  return Array.isArray(images) && images.length <= TTY_MAX_IMAGES &&
    images.every((i) =>
      typeof i === "object" && i !== null &&
      TTY_IMAGE_TYPES.includes((i as { mediaType?: string }).mediaType ?? "") &&
      typeof (i as { data?: string }).data === "string" &&
      (i as { data: string }).data.length <= TTY_MAX_IMAGE_BYTES
    );
}

/**
 * The REPL as a network surface: GET {path} upgrades to a WebSocket carrying
 * JSON frames. The client sends `{type: "input", text}`; the server streams
 * the run's progress (step, assistant, tool_call, tool_result, compaction)
 * and finishes each turn with `{type: "result", status, reply, steps}`.
 *
 * Auth is a bearer token — the `authorization` header, or (for browsers,
 * which cannot set headers on a WebSocket) the subprotocol `bearer.<token>`,
 * which the server selects back on the upgrade.
 *
 * One session per socket: reconnect with `?conversation_id=<id>` to resume
 * the same conversation.
 */
export class TtyTrigger implements Trigger {
  /** Trigger name, used as the event's `trigger` field. */
  readonly name = "tty";
  #opts: TtyTriggerOptions;
  #server?: Deno.HttpServer;
  /** Open sockets by conversation key, for proactive delivery. */
  #sockets = new Map<string, Set<WebSocket>>();

  /** Create the trigger; no server runs until {@linkcode start}. */
  constructor(opts: TtyTriggerOptions) {
    this.#opts = opts;
  }

  #authorized(req: Request): { ok: boolean; protocol?: string } {
    const { token } = this.#opts;
    const header = req.headers.get("authorization");
    if (header) return { ok: timingSafeEqual(header, `Bearer ${token}`) };
    const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
      .split(",").map((p) => p.trim());
    const bearer = protocols.find((p) => p.startsWith("bearer."));
    if (bearer) {
      return { ok: timingSafeEqual(bearer, `bearer.${token}`), protocol: bearer };
    }
    return { ok: false };
  }

  /** Start the server; each authorized upgrade becomes an interactive session. */
  start(
    emit: (event: AgentEvent, opts?: HandleOptions) => Promise<RunResult>,
    stop: (conversationKey: string) => boolean,
  ): Promise<void> {
    const { path, port } = this.#opts;
    this.#server = Deno.serve({
      port,
      onListen: this.#opts.onListen ?? ((addr) => {
        logInfo(`tty trigger listening on :${addr.port}${path}`);
      }),
    }, (req) => {
      const url = new URL(req.url);
      if (url.pathname !== path) return Response.json({ error: "not found" }, { status: 404 });
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "websocket upgrade required" }, { status: 426 });
      }
      const auth = this.#authorized(req);
      if (!auth.ok) return Response.json({ error: "unauthorized" }, { status: 401 });

      // The upgrade must echo a subprotocol the client offered, so token-via-
      // subprotocol sessions get their own `bearer.<token>` selected back.
      const { socket, response } = Deno.upgradeWebSocket(
        req,
        auth.protocol ? { protocol: auth.protocol } : {},
      );
      const conversationId = url.searchParams.get("conversation_id") ?? crypto.randomUUID();
      const conversationKey = `tty:${conversationId}`;
      this.#attach(socket, emit, stop, conversationId, conversationKey);
      return response;
    });
    return Promise.resolve();
  }

  #attach(
    socket: WebSocket,
    emit: (event: AgentEvent, opts?: HandleOptions) => Promise<RunResult>,
    stop: (conversationKey: string) => boolean,
    conversationId: string,
    conversationKey: string,
  ): void {
    const send = (frame: TtyServerFrame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };
    let running = false;

    socket.onopen = () => {
      let set = this.#sockets.get(conversationKey);
      if (!set) this.#sockets.set(conversationKey, set = new Set());
      set.add(socket);
      const { handle, name, description } = this.#opts;
      send({
        type: "hello",
        handle,
        name,
        ...(description ? { description } : {}),
        conversation_id: conversationId,
      });
    };
    socket.onclose = () => {
      const set = this.#sockets.get(conversationKey);
      set?.delete(socket);
      if (set?.size === 0) this.#sockets.delete(conversationKey);
    };
    socket.onmessage = async (msg) => {
      let frame: TtyClientFrame;
      try {
        frame = JSON.parse(String(msg.data));
      } catch {
        return send({ type: "error", error: "frames must be JSON" });
      }
      // Cancel is the one frame allowed through mid-run: it fires the lane's
      // abort so the in-flight run halts and sends its own aborted result. A
      // no-op when nothing is running, so a stray cancel is harmless.
      if (frame.type === "cancel") {
        stop(conversationKey);
        return;
      }
      if (frame.type !== "input" || typeof frame.text !== "string" || !frame.text.trim()) {
        return send({ type: "error", error: 'expected {type: "input", text: "..."}' });
      }
      if (!validImages(frame.images)) {
        return send({
          type: "error",
          error:
            `images must be at most ${TTY_MAX_IMAGES} of {mediaType: png|jpeg|gif|webp, data: base64}`,
        });
      }
      // One run at a time per socket — the terminal is a conversation, not a queue.
      if (running) return send({ type: "error", error: "a run is already in progress" });
      running = true;
      try {
        const result = await emit(
          {
            id: crypto.randomUUID(),
            trigger: this.name,
            input: frame.text,
            images: frame.images?.length ? frame.images : undefined,
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
        send({ type: "result", status: result.status, reply: result.reply, steps: result.steps });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : String(err) });
      } finally {
        running = false;
      }
    };
  }

  /** Push a scheduled message into any open terminal on that conversation. */
  deliver(conversationKey: string, text: string): Promise<boolean> {
    const set = this.#sockets.get(conversationKey);
    if (!set?.size) return Promise.resolve(false);
    const frame = JSON.stringify({ type: "message", text } satisfies TtyServerFrame);
    for (const socket of set) {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    }
    return Promise.resolve(true);
  }

  /** Close every session and shut down the server. */
  async stop(): Promise<void> {
    for (const set of this.#sockets.values()) {
      for (const socket of set) socket.close(1001, "agent shutting down");
    }
    this.#sockets.clear();
    await this.#server?.shutdown();
  }
}
