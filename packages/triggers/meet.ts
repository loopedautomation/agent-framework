import { logError, logInfo, logWarn } from "@looped/core";
import type { AgentEvent, HandleOptions, RunResult, Trigger } from "@looped/core";
import { TtyTrigger } from "./tty.ts";

/** Options for {@linkcode MeetTrigger}. */
export interface MeetTriggerOptions {
  /** The Looped Meet instance to register with, e.g. https://meet.example.com. */
  baseUrl: string;
  /** Externally reachable HTTPS base of this agent; meet dials back its wss:// equivalent. */
  publicUrl: string;
  /** URL path that accepts the WebSocket upgrade from the meet bridge. */
  path: string;
  /** TCP port to listen on. */
  port: number;
  /** The bearer token the meet bridge must present when dialing in. */
  token: string;
  /** The meet-issued registration token (lreg_…) for register + deliver calls. */
  registrationToken: string;
  /** The operator's handle for this agent, announced in the hello frame. */
  handle: string;
  /** The agent's self-chosen identity name, announced in the hello frame. */
  name: string;
  /** The agent's job description, announced in the hello frame and registration. */
  description?: string;
  /** Injectable for tests: 0 picks an ephemeral port. */
  onListen?: (addr: { port: number }) => void;
  /** Injectable for tests: HTTP client for register/deliver calls. */
  fetch?: typeof fetch;
  /** Injectable for tests: base delay between registration retries. */
  registrationRetryMs?: number;
}

/** Registration attempts before giving up until the next boot. */
const REGISTER_ATTEMPTS = 5;
const REGISTER_RETRY_MS = 2_000;

/**
 * Join a Looped Meet instance as a persistent agent. The trigger serves the
 * tty WebSocket protocol (same frames, `meet:` conversation keys) for the meet
 * bridge to dial into, self-registers with the instance on every startup —
 * idempotent on the meet side, keyed by the registration token — and delivers
 * proactive messages either down a live socket or over meet's messages API
 * when no bridge session is connected.
 *
 * The inbound-dial shape is what makes scale-to-zero work: a stopped host
 * wakes when the bridge reconnects, boots, and re-registers.
 */
export class MeetTrigger implements Trigger {
  /** Trigger name, used as the event's `trigger` field. */
  readonly name = "meet";
  #opts: MeetTriggerOptions;
  #inner: TtyTrigger;
  #fetch: typeof fetch;
  #stopped = false;

  /** Create the trigger; no server runs until {@linkcode start}. */
  constructor(opts: MeetTriggerOptions) {
    this.#opts = opts;
    this.#fetch = opts.fetch ?? fetch;
    this.#inner = new TtyTrigger({
      triggerName: "meet",
      path: opts.path,
      port: opts.port,
      token: opts.token,
      handle: opts.handle,
      name: opts.name,
      description: opts.description,
      onListen: opts.onListen ?? ((addr) => {
        logInfo(`meet trigger listening on :${addr.port}${opts.path}`);
      }),
    });
  }

  /** The wss:// dial-back URL registration hands to meet. */
  get #dialUrl(): string {
    const base = this.#opts.publicUrl.replace(/\/$/, "").replace(/^http/, "ws");
    return `${base}${this.#opts.path}`;
  }

  /** Start the WebSocket server, then self-register with the meet instance. */
  async start(
    emit: (event: AgentEvent, opts?: HandleOptions) => Promise<RunResult>,
    stop: (conversationKey: string) => boolean,
  ): Promise<void> {
    await this.#inner.start(emit, stop);
    // Fire-and-forget: the meet instance may itself be scaled to zero or
    // temporarily down, and an unregistered agent still serves inbound dials —
    // registration failing must never take the agent down with it.
    this.#register();
  }

  async #register(): Promise<void> {
    const { baseUrl, registrationToken, name, description, token } = this.#opts;
    const retryMs = this.#opts.registrationRetryMs ?? REGISTER_RETRY_MS;
    for (let attempt = 1; attempt <= REGISTER_ATTEMPTS && !this.#stopped; attempt++) {
      try {
        const res = await this.#fetch(`${baseUrl.replace(/\/$/, "")}/api/agents/register`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${registrationToken}`,
          },
          body: JSON.stringify({
            name,
            ...(description ? { description } : {}),
            url: this.#dialUrl,
            token,
          }),
        });
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          logInfo(`meet trigger: registered with ${baseUrl} as ${body.agentId ?? name}`);
          return;
        }
        // 4xx is a config problem (bad or revoked registration token) that a
        // retry cannot fix; say so once and stop trying until the next boot.
        if (res.status >= 400 && res.status < 500) {
          logError(
            `meet trigger: registration rejected by ${baseUrl} (${res.status} ${await res
              .text()
              .catch(() => "")}) — check the registration token`,
          );
          return;
        }
        logWarn(`meet trigger: registration attempt ${attempt} got ${res.status}, retrying`);
      } catch (err) {
        logWarn(
          `meet trigger: registration attempt ${attempt} failed (${
            err instanceof Error ? err.message : err
          }), retrying`,
        );
      }
      if (attempt < REGISTER_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, retryMs * attempt));
      }
    }
    if (!this.#stopped) {
      logError(
        `meet trigger: could not register with ${baseUrl} after ${REGISTER_ATTEMPTS} attempts; ` +
          "serving inbound sessions anyway (registration retries on next boot)",
      );
    }
  }

  /**
   * Push a scheduled message into the conversation: down a live bridge socket
   * when one is connected, else over meet's messages API for text channels
   * (`meet:meet-text-<channelPublicId>` keys). Meeting-room conversations with
   * no live socket have nowhere durable to land, so those return false.
   */
  async deliver(conversationKey: string, text: string): Promise<boolean> {
    if (!conversationKey.startsWith("meet:")) return false;
    if (await this.#inner.deliver(conversationKey, text)) return true;
    const conversationId = conversationKey.slice("meet:".length);
    if (!conversationId.startsWith("meet-text-")) return false;
    const channel = conversationId.slice("meet-text-".length);
    try {
      const res = await this.#fetch(
        `${this.#opts.baseUrl.replace(/\/$/, "")}/api/agents/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.#opts.registrationToken}`,
          },
          body: JSON.stringify({ channel, text }),
        },
      );
      if (!res.ok) {
        logWarn(`meet trigger: delivery to channel ${channel} got ${res.status}`);
      }
      return res.ok;
    } catch (err) {
      logWarn(
        `meet trigger: delivery to channel ${channel} failed (${
          err instanceof Error ? err.message : err
        })`,
      );
      return false;
    }
  }

  /** Close every session and shut down the server. */
  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#inner.stop();
  }
}
