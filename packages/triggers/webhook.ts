import type { AgentEvent, RunResult, Trigger } from "@looped/core";

/** Options for {@linkcode WebhookTrigger}. */
export interface WebhookTriggerOptions {
  /** URL path the trigger accepts POSTs on. */
  path: string;
  /** TCP port to listen on. */
  port: number;
  /** The expected bearer token (already resolved from token_env). */
  token: string;
  /** Injectable for tests: 0 picks an ephemeral port. */
  onListen?: (addr: { port: number }) => void;
}

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
 * POST {path} with `authorization: Bearer <token>` and a JSON body:
 *   { "input": "...", "conversation_id": "optional-session-key" }
 * Responds synchronously with the run result.
 */
export class WebhookTrigger implements Trigger {
  /** Trigger name, used as the event's `trigger` field. */
  readonly name = "webhook";
  #opts: WebhookTriggerOptions;
  #server?: Deno.HttpServer;

  /** Create the trigger; no server runs until {@linkcode start}. */
  constructor(opts: WebhookTriggerOptions) {
    this.#opts = opts;
  }

  /** Start the HTTP server; each authorized POST emits an event and returns the run result. */
  start(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void> {
    const { path, port, token } = this.#opts;
    this.#server = Deno.serve({
      port,
      onListen: this.#opts.onListen ?? ((addr) => {
        console.log(`webhook trigger listening on :${addr.port}${path}`);
      }),
    }, async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== path) return Response.json({ error: "not found" }, { status: 404 });
      if (req.method !== "POST") {
        return Response.json({ error: "method not allowed" }, { status: 405 });
      }
      const auth = req.headers.get("authorization") ?? "";
      if (!timingSafeEqual(auth, `Bearer ${token}`)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      let body: { input?: unknown; conversation_id?: unknown };
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "body must be JSON" }, { status: 400 });
      }
      if (typeof body.input !== "string" || !body.input.trim()) {
        return Response.json({ error: "body.input (string) is required" }, { status: 400 });
      }

      const result = await emit({
        id: crypto.randomUUID(),
        trigger: this.name,
        input: body.input,
        conversationKey: typeof body.conversation_id === "string"
          ? `webhook:${body.conversation_id}`
          : undefined,
      });
      // 429 marks a queue refusal — the caller can back off and retry.
      const httpStatus = result.status === "ok" ? 200 : result.status === "rejected" ? 429 : 500;
      return Response.json({
        status: result.status,
        reply: result.reply,
        steps: result.steps,
      }, { status: httpStatus });
    });
    return Promise.resolve();
  }

  /** Shut down the HTTP server. */
  async stop(): Promise<void> {
    await this.#server?.shutdown();
  }
}
