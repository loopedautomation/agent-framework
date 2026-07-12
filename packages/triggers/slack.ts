import { logError, logInfo, resolveAttachments, withNotes } from "@looped/core";
import type { AgentEvent, Attachment, MediaLimits, RunResult, Trigger } from "@looped/core";
import { NO_REPLY, splitMessage } from "./text.ts";

// A deliberately minimal Slack Socket Mode client: open a socket, ack
// envelopes, handle message events, reconnect-with-backoff. No library,
// no public endpoint (Plan 0, principle 8).
//
// The Slack app needs Socket Mode enabled, an app-level token with
// connections:write, and event subscriptions for message.channels /
// message.groups / message.im (plus matching *:history read scopes).

const API = "https://slack.com/api";
// Slack's recommended per-message max for chat.postMessage text.
const LIMIT = 4000;

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
  /** App-level token (xapp-…, connections:write) — opens the Socket Mode connection. */
  appToken: string;
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
  #stopped = false;
  #botUserId = "";
  #channelNames = new Map<string, string | undefined>();
  #reconnectDelayMs = 1_000;

  /** Create the trigger; nothing connects until {@linkcode start}. */
  constructor(opts: SlackTriggerOptions) {
    this.#opts = opts;
  }

  async #api(method: string, body?: unknown, token = this.#opts.token): Promise<
    // deno-lint-ignore no-explicit-any
    any
  > {
    const res = await fetch(`${API}/${method}`, {
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

  /** Open the Socket Mode connection; matching messages emit events and get replies. */
  async start(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void> {
    const auth = await this.#api("auth.test");
    if (!auth.ok) {
      throw new Error(`slack: auth.test failed (${auth.error}) — check the bot token`);
    }
    this.#botUserId = auth.user_id;
    await this.#connect(emit);
    logInfo(`slack trigger connected as ${auth.user}`);
  }

  async #connect(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void> {
    if (this.#stopped) return;
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

  /** Close the socket and stop reconnecting. */
  stop(): Promise<void> {
    this.#stopped = true;
    this.#ws?.close();
    return Promise.resolve();
  }
}
