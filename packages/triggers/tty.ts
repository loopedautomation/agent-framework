import { logInfo } from "@looped/core";
import type { AgentEvent, HandleOptions, RunResult, Trigger } from "@looped/core";

/** Options for {@linkcode TtyTrigger}. */
export interface TtyTriggerOptions {
  /** URL path that accepts the WebSocket upgrade. */
  path: string;
  /** TCP port to listen on. */
  port: number;
  /** The expected bearer token (already resolved from token_env). */
  token: string;
  /** The agent's handle, announced in the hello frame. */
  handle: string;
  /** Injectable for tests: 0 picks an ephemeral port. */
  onListen?: (addr: { port: number }) => void;
}

/** A frame the server sends to a connected terminal. */
export type TtyServerFrame =
  /** Sent once on connect. */
  | { type: "hello"; handle: string; conversation_id: string }
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
export type TtyClientFrame = { type: "input"; text: string };

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
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
  start(emit: (event: AgentEvent, opts?: HandleOptions) => Promise<RunResult>): Promise<void> {
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
      this.#attach(socket, emit, conversationId, conversationKey);
      return response;
    });
    return Promise.resolve();
  }

  #attach(
    socket: WebSocket,
    emit: (event: AgentEvent, opts?: HandleOptions) => Promise<RunResult>,
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
      send({ type: "hello", handle: this.#opts.handle, conversation_id: conversationId });
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
      if (frame.type !== "input" || typeof frame.text !== "string" || !frame.text.trim()) {
        return send({ type: "error", error: 'expected {type: "input", text: "..."}' });
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
