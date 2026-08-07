import {
  BodyTooLargeError,
  logError,
  logInfo,
  readCapped,
  resolveAttachments,
  timingSafeEqual,
  withNotes,
} from "@looped/core";
import type { AgentEvent, Attachment, MediaLimits, RunResult, Trigger } from "@looped/core";
import { NO_REPLY, splitMessage } from "./text.ts";

// A deliberately minimal Slack client with two delivery transports. socket
// (the default) is Socket Mode: open a socket, ack envelopes, handle message
// events, reconnect-with-backoff — no library, no public endpoint (Plan 0,
// principle 8). events_api serves Slack's Events API over inbound HTTPS
// instead, so the process can sleep between messages on scale-to-zero hosts:
// Slack retries undelivered events (up to 3×), and the retry is what wakes
// the host back up.
//
// Either way the Slack app needs event subscriptions for message.channels /
// message.groups / message.im (plus matching *:history read scopes). socket
// additionally needs Socket Mode enabled and an app-level token with
// connections:write; events_api instead needs the request URL enabled in the
// app config and the signing secret to verify deliveries.

const API = "https://slack.com/api";
// Slack's recommended per-message max for chat.postMessage text.
const LIMIT = 4000;

/** Inputs for {@linkcode verifySlackSignature}. */
export interface SlackVerifyOptions {
  /** The app's signing secret from the Slack app config. */
  signingSecret: string;
  /** The X-Slack-Request-Timestamp header: unix seconds. */
  timestamp: string;
  /** The X-Slack-Signature header: `v0=<hex>`. */
  signature: string;
  /** The raw request body — the signature is over the exact bytes. */
  body: string;
  /** Injectable clock for tests (unix seconds). */
  now?: () => number;
}

/**
 * Ceiling on a single Events API delivery. Slack's own ceilings are far under
 * this — a message tops out at 40k characters, blocks at 50 per message, and a
 * slash command is a short form post — so a megabyte leaves room for the
 * largest realistic event and still refuses a body sent to exhaust memory. The
 * read happens before the signature can be checked, which is what needs the cap.
 */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

/** Signatures older than this are replays, not slow networks. */
const MAX_SIGNATURE_AGE_SECS = 300;

/**
 * Verify a Slack Events API request: HMAC-SHA256 over `v0:<timestamp>:<body>`
 * with the signing secret, hex-encoded, compared timing-safe against the
 * X-Slack-Signature header. Stale timestamps fail too — a valid signature
 * from an hour ago is a replay. An unsigned request never reaches the parser.
 */
export async function verifySlackSignature(opts: SlackVerifyOptions): Promise<boolean> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const age = Math.abs(now() - Number(opts.timestamp));
  if (!Number.isFinite(age) || age > MAX_SIGNATURE_AGE_SECS) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(opts.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${opts.timestamp}:${opts.body}`),
  );
  const expected = "v0=" +
    [...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(opts.signature, expected);
}

export interface SlackMessage {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
}

/** A file uploaded with a message (the fields this trigger reads). */
export interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  /** Slack's own transcript of a voice clip. Unread today — see Plan 14. */
  transcription?: { status?: string; preview?: { content?: string } };
}

/** The caps a hand-built trigger uses when the config's `limits:` block isn't threaded in. */
const DEFAULT_MEDIA: MediaLimits = { maxImageBytes: 5_000_000, maxImagesPerMessage: 4 };

/** What the agent reads when an upload arrives with no message text. */
const NO_CAPTION = "(the user sent this with no message text.)";

/** The message's uploads, as the media layer sees them. */
export function slackAttachments(
  msg: SlackMessage,
  token: string,
  fetchFn: typeof fetch = fetch,
): Attachment[] {
  return (msg.files ?? []).map((f) => ({
    filename: f.name,
    mediaType: f.mimetype,
    size: f.size,
    fetch: async () => {
      // url_private is not public despite being a url: it needs the bot token
      // and the files:read scope, and answers HTML (a login page) without them.
      const res = await fetchFn(f.url_private ?? "", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`slack file download returned ${res.status}`);
      }
      // A bot without files:read gets a 200 carrying Slack's sign-in page
      // rather than a 401. Trusting the status alone would hand the model an
      // HTML document with an image's media type on it: a corrupt picture,
      // silently, where the operator deserves to be told about a missing scope.
      const type = res.headers.get("content-type") ?? "";
      if (!type.startsWith("image/")) {
        await res.body?.cancel();
        throw new Error(
          `slack served ${type || "no content-type"} for ${f.name ?? "a file"} — ` +
            `the bot is probably missing the files:read scope`,
        );
      }
      return new Uint8Array(await res.arrayBuffer());
    },
  }));
}

/** Message filters shared by {@linkcode shouldHandle} and {@linkcode SlackTriggerOptions}. */
export interface SlackFilterOptions {
  /** Channel names or ids to listen in; empty/undefined = all channels the bot is in. */
  channels?: string[];
  /** Only handle messages that @-mention the bot (DMs always pass). */
  requireMention?: boolean;
  /** Only handle messages from these Slack user ids (U…); empty/undefined = anyone. */
  fromUsers?: string[];
}

/** Pure filter: should this message wake the agent? (unit-tested) */
export function shouldHandle(
  msg: SlackMessage,
  botUserId: string,
  channelName: string | undefined,
  opts: SlackFilterOptions,
): boolean {
  if (msg.type !== "message") return false;
  // Subtypes are edits, joins, bot posts, … — none of them wake the agent. An
  // upload is the exception: a file arrives as the file_share subtype, and a
  // screenshot dropped in a channel is someone talking to the agent.
  if (msg.subtype && msg.subtype !== "file_share") return false;
  if (msg.bot_id || !msg.user || msg.user === botUserId) return false;
  // The author gate runs before the model is ever called — messages from
  // unlisted authors are dropped here and never reach the provider.
  if (opts.fromUsers?.length && !opts.fromUsers.includes(msg.user)) return false;
  if (!msg.text?.trim() && !msg.files?.length) return false;
  if (opts.channels?.length) {
    const match = opts.channels.includes(msg.channel) ||
      (channelName !== undefined && opts.channels.includes(channelName));
    if (!match) return false;
  }
  // A DM addresses the bot by definition; mentions only gate channels.
  if (
    opts.requireMention && msg.channel_type !== "im" &&
    !(msg.text ?? "").includes(`<@${botUserId}>`)
  ) return false;
  return true;
}

/** A Slack slash-command payload (the fields this trigger reads). */
export interface SlackSlashCommand {
  command: string;
  text?: string;
  user_id: string;
  channel_id: string;
  response_url: string;
}

/** Options for {@linkcode SlackTrigger}. */
export interface SlackTriggerOptions extends SlackFilterOptions {
  /** Bot token (xoxb-…) — reads channel info, posts replies. */
  token: string;
  /** App-level token (xapp-…, connections:write) — required by the socket transport. */
  appToken?: string;
  /** How events arrive: Socket Mode (default) or the Events API over inbound HTTP. */
  transport?: "socket" | "events_api";
  /** events_api transport: TCP port to listen on. */
  port?: number;
  /** events_api transport: URL path Slack POSTs event deliveries to. */
  path?: string;
  /** events_api transport: the app's signing secret — every delivery is verified. */
  signingSecret?: string;
  /** Injectable for tests: 0 picks an ephemeral port. */
  onListen?: (addr: { port: number }) => void;
  /** Injectable for tests: a fake Web API server stands in for slack.com/api. */
  apiBase?: string;
  /** Post replies into this channel id instead of the source thread. */
  replyChannel?: string;
  /** Suppress the reply when the agent answers with the NO_REPLY sentinel (or nothing). */
  allowSilence?: boolean;
  /** What an image uploaded to a channel may cost (from the agent's `limits:` block). */
  media?: MediaLimits;
}

/**
 * Listens over Slack Socket Mode and wakes the agent on matching messages,
 * replying in the source thread (or a configured reply channel).
 */
export class SlackTrigger implements Trigger {
  /** Trigger name, used as the event's `trigger` field. */
  readonly name = "slack";
  #opts: SlackTriggerOptions;
  #ws?: WebSocket;
  #server?: Deno.HttpServer;
  #stopped = false;
  #botUserId = "";
  #channelNames = new Map<string, string | undefined>();
  #reconnectDelayMs = 1_000;
  // Slack retries deliveries a cold boot or slow ack ate — insertion-ordered
  // so pruning drops the oldest ids first.
  #seenEventIds = new Set<string>();

  /** Create the trigger; nothing connects until {@linkcode start}. */
  constructor(opts: SlackTriggerOptions) {
    this.#opts = opts;
  }

  async #api(method: string, body?: unknown, token = this.#opts.token): Promise<
    // deno-lint-ignore no-explicit-any
    any
  > {
    const res = await fetch(`${this.#opts.apiBase ?? API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: body === undefined ? "{}" : JSON.stringify(body),
    });
    return await res.json();
  }

  async #channelName(channelId: string): Promise<string | undefined> {
    if (!this.#channelNames.has(channelId)) {
      const info = await this.#api("conversations.info", { channel: channelId });
      this.#channelNames.set(channelId, info.ok ? info.channel?.name : undefined);
    }
    return this.#channelNames.get(channelId);
  }

  async #reply(msg: SlackMessage, result: RunResult) {
    const reply = (result.reply ?? "").trim();

    // The agent had nothing to say — with allow_silence, say nothing.
    if (this.#opts.allowSilence && (reply === NO_REPLY || reply === "")) return;

    // Where to post: a dedicated reply channel, else the source thread.
    const target = this.#opts.replyChannel ?? msg.channel;
    const inSourceChannel = target === msg.channel;

    let body = reply || `(${result.status})`;
    if (!inSourceChannel) {
      // Out-of-channel replies carry their own context: quote the triggering
      // message and link back.
      const permalink = await this.#api("chat.getPermalink", {
        channel: msg.channel,
        message_ts: msg.ts,
      });
      const link = permalink.ok ? ` (<${permalink.permalink}|jump>)` : "";
      const quoted = (msg.text ?? "").replace(/\n/g, "\n> ");
      body = `On this message${link}:\n> ${quoted}\n\n${body}`;
    }

    // In-channel replies thread under the triggering message (DMs stay flat).
    const threadTs = inSourceChannel
      ? msg.thread_ts ?? (msg.channel_type === "im" ? undefined : msg.ts)
      : undefined;

    for (const part of splitMessage(body, LIMIT)) {
      const res = await this.#api("chat.postMessage", {
        channel: target,
        text: part,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      if (!res.ok) logError(`slack: reply failed: ${res.error}`);
    }
  }

  /**
   * Proactive send (agent-created schedules): "slack:<channel>" and
   * "slack:<channel>:<thread_ts>" keys are ours; a threaded key posts into
   * its thread.
   */
  async deliver(conversationKey: string, text: string): Promise<boolean> {
    const match = conversationKey.match(/^slack:([^:]+)(?::(.+))?$/);
    if (!match) return false;
    for (const part of splitMessage(text, LIMIT)) {
      const res = await this.#api("chat.postMessage", {
        channel: match[1],
        text: part,
        ...(match[2] ? { thread_ts: match[2] } : {}),
      });
      if (!res.ok) logError(`slack: deliver failed: ${res.error}`);
    }
    return true;
  }

  async #handle(msg: SlackMessage, emit: (event: AgentEvent) => Promise<RunResult>) {
    const channelName = this.#opts.channels?.length
      ? await this.#channelName(msg.channel)
      : undefined;
    if (!shouldHandle(msg, this.#botUserId, channelName, this.#opts)) return;
    const media = await resolveAttachments(
      slackAttachments(msg, this.#opts.token),
      this.#opts.media ?? DEFAULT_MEDIA,
    );
    const result = await emit({
      id: `${msg.channel}:${msg.ts}`,
      trigger: this.name,
      // Conversations are keyed per thread; a DM is one rolling conversation.
      // An upload with no caption still needs a prompt: the model is told what
      // it is looking at rather than handed an empty turn.
      input: withNotes((msg.text ?? "").trim() || NO_CAPTION, media.notes),
      images: media.images,
      conversationKey: msg.channel_type === "im"
        ? `slack:${msg.channel}`
        : `slack:${msg.channel}:${msg.thread_ts ?? msg.ts}`,
    });
    await this.#reply(msg, result);
  }

  /**
   * A Slack slash command (registered in the app config, delivered over
   * Socket Mode — messages starting with "/" never arrive as message events).
   * The reply goes through the command's response_url, visible in-channel.
   */
  async #handleSlashCommand(
    cmd: SlackSlashCommand,
    emit: (event: AgentEvent) => Promise<RunResult>,
  ) {
    // The same author gate as messages, before the model is called.
    if (this.#opts.fromUsers?.length && !this.#opts.fromUsers.includes(cmd.user_id)) return;
    const text = (cmd.text ?? "").trim();
    const result = await emit({
      id: `${cmd.channel_id}:${cmd.command}:${crypto.randomUUID()}`,
      trigger: this.name,
      input: `${cmd.command}${text ? ` ${text}` : ""}`,
      conversationKey: `slack:${cmd.channel_id}`,
    });
    const body = (result.reply ?? "").trim() || `(${result.status})`;
    for (const part of splitMessage(body, LIMIT)) {
      const res = await fetch(cmd.response_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response_type: "in_channel", text: part }),
      });
      if (!res.ok) logError(`slack: slash command reply failed (${res.status})`);
      await res.body?.cancel();
    }
  }

  /** Start the configured transport; matching messages emit events and get replies. */
  async start(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void> {
    const auth = await this.#api("auth.test");
    if (!auth.ok) {
      throw new Error(`slack: auth.test failed (${auth.error}) — check the bot token`);
    }
    this.#botUserId = auth.user_id;
    if (this.#opts.transport === "events_api") {
      this.#serveEvents(emit);
      logInfo(`slack trigger connected as ${auth.user} (events_api)`);
      return;
    }
    await this.#connect(emit);
    logInfo(`slack trigger connected as ${auth.user}`);
  }

  /** Seen before? Records the id; the set is pruned so it never grows unbounded. */
  #alreadySeen(eventId: string): boolean {
    if (this.#seenEventIds.has(eventId)) return true;
    this.#seenEventIds.add(eventId);
    if (this.#seenEventIds.size > 1_000) {
      for (const id of this.#seenEventIds) {
        this.#seenEventIds.delete(id);
        if (this.#seenEventIds.size <= 1_000) break;
      }
    }
    return false;
  }

  /**
   * Serve Slack's Events API. Every delivery is verified against the signing
   * secret before parsing, the url_verification handshake is answered so the
   * request URL can be enabled in the app config, and everything else is
   * acked within Slack's 3-second deadline — the run happens after. Slack
   * retries deliveries it thinks failed (up to 3×, and a cold boot often eats
   * the first attempt), so events are deduped on event_id. Slash commands
   * arrive form-encoded on the same URL and reply through their response_url.
   */
  #serveEvents(emit: (event: AgentEvent) => Promise<RunResult>) {
    const path = this.#opts.path ?? "/slack";
    const signingSecret = this.#opts.signingSecret;
    if (!signingSecret) {
      throw new Error("slack: the events_api transport requires the signing secret");
    }
    this.#server = Deno.serve({
      port: this.#opts.port ?? 8080,
      onListen: this.#opts.onListen ?? ((addr) => {
        logInfo(`slack trigger listening on :${addr.port}${path}`);
      }),
    }, async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== path) return Response.json({ error: "not found" }, { status: 404 });
      if (req.method !== "POST") {
        return Response.json({ error: "method not allowed" }, { status: 405 });
      }

      // The signature is over the exact bytes, so they have to arrive before
      // there is any reason to trust the sender. A chunked request declares no
      // length, so the count happens as the stream arrives and a sender that
      // runs over is disconnected rather than followed.
      let body: string;
      try {
        body = new TextDecoder().decode(await readCapped(req.body, MAX_WEBHOOK_BYTES));
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          return Response.json({ error: "body too large" }, { status: 413 });
        }
        return Response.json({ error: "could not read body" }, { status: 400 });
      }
      const verified = await verifySlackSignature({
        signingSecret,
        timestamp: req.headers.get("x-slack-request-timestamp") ?? "",
        signature: req.headers.get("x-slack-signature") ?? "",
        body,
      });
      if (!verified) return Response.json({ error: "invalid signature" }, { status: 401 });

      // Slash commands ride the same signature scheme but arrive form-encoded.
      const contentType = req.headers.get("content-type") ?? "";
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const form = new URLSearchParams(body);
        const command = form.get("command");
        if (command) {
          this.#handleSlashCommand({
            command,
            text: form.get("text") ?? undefined,
            user_id: form.get("user_id") ?? "",
            channel_id: form.get("channel_id") ?? "",
            response_url: form.get("response_url") ?? "",
          }, emit).catch((err) => logError(`slack: slash command handling failed: ${err}`));
        }
        return new Response(null, { status: 200 });
      }

      let payload: {
        type?: string;
        challenge?: string;
        event_id?: string;
        event?: SlackMessage & { type?: string };
      };
      try {
        payload = JSON.parse(body);
      } catch {
        return Response.json({ error: "body must be JSON" }, { status: 400 });
      }

      // The app-config handshake: echo the challenge, no model call.
      if (payload.type === "url_verification") {
        return Response.json({ challenge: payload.challenge });
      }

      if (payload.type === "event_callback") {
        const eventId = payload.event_id;
        if (eventId && this.#alreadySeen(eventId)) {
          return Response.json({ deduplicated: true });
        }
        // app_mention duplicates the message event; handling both would double-run.
        if (payload.event?.type === "message") {
          this.#handle(payload.event, emit).catch((err) =>
            logError(`slack: handling failed: ${err}`)
          );
        }
      }
      return Response.json({ ok: true });
    });
  }

  async #connect(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void> {
    if (this.#stopped) return;
    if (!this.#opts.appToken) {
      throw new Error("slack: the socket transport requires the app-level token");
    }
    // Socket Mode URLs are single-use — fetch a fresh one on every (re)connect.
    const open = await this.#api("apps.connections.open", undefined, this.#opts.appToken);
    if (!open.ok) {
      throw new Error(
        `slack: apps.connections.open failed (${open.error}) — check the app-level token (connections:write)`,
      );
    }
    const ws = new WebSocket(open.url);
    this.#ws = ws;

    ws.onmessage = (raw) => {
      const payload = JSON.parse(raw.data);
      switch (payload.type) {
        case "hello":
          this.#reconnectDelayMs = 1_000;
          break;
        case "disconnect": // Slack refreshes sockets routinely; close → reconnect
          ws.close();
          break;
        case "events_api": {
          // Ack immediately — agent runs outlast Slack's 3s retry window.
          ws.send(JSON.stringify({ envelope_id: payload.envelope_id }));
          const event = payload.payload?.event;
          // app_mention duplicates the message event; handling both would double-run.
          if (event?.type === "message") {
            this.#handle(event as SlackMessage, emit).catch((err) =>
              logError(`slack: handling failed: ${err}`)
            );
          }
          break;
        }
        case "slash_commands": {
          // Ack immediately — agent runs outlast Slack's 3s window; the real
          // reply follows via response_url.
          ws.send(JSON.stringify({ envelope_id: payload.envelope_id }));
          this.#handleSlashCommand(payload.payload as SlackSlashCommand, emit).catch((err) =>
            logError(`slack: slash command handling failed: ${err}`)
          );
          break;
        }
      }
    };

    ws.onclose = () => this.#reconnect(emit, "socket closed");
    ws.onerror = () => ws.close();
  }

  #reconnect(emit: (event: AgentEvent) => Promise<RunResult>, why: string) {
    if (this.#stopped) return;
    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(delay * 2, 60_000);
    logInfo(`slack: ${why}, reconnecting in ${delay}ms`);
    setTimeout(() => {
      this.#connect(emit).catch((err) => this.#reconnect(emit, `reconnect failed (${err})`));
    }, delay);
  }

  /** Stop the transport: close the socket (and stop reconnecting) or shut the server down. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#ws?.close();
    await this.#server?.shutdown();
  }
}
