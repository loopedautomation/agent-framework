import type { AgentEvent, RunResult, Trigger } from "@looped/core";
import { NO_REPLY, splitMessage } from "./text.ts";

// A deliberately minimal Discord gateway client: identify, heartbeat,
// MESSAGE_CREATE, reconnect-with-backoff. No library — the framework's
// only job here is "message in, reply in thread", and a dependency-free
// ~200 lines keeps the container minimal (Plan 0, principle 8).

const API = "https://discord.com/api/v10";
// GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

export { NO_REPLY, splitMessage };

/**
 * Permission bitfield the invite URL requests:
 * VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY.
 */
export const INVITE_PERMISSIONS = (1 << 10) | (1 << 11) | (1 << 16);

/** The OAuth invite URL for a bot application — so nobody computes permission bitfields by hand. */
export function inviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${INVITE_PERMISSIONS}`;
}

/** Fetch the bot's application id (the client_id the invite URL needs). */
export async function fetchApplicationId(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(`${API}/applications/@me`, {
    headers: { authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(
      `discord: cannot fetch application info (${res.status}) — check the bot token`,
    );
  }
  return (await res.json()).id;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: { id: string; bot?: boolean; username?: string };
  mentions?: { id: string }[];
}

/** Message filters shared by {@linkcode shouldHandle} and {@linkcode DiscordTriggerOptions}. */
export interface DiscordFilterOptions {
  /** Channel names or ids to listen in; empty/undefined = all channels. */
  channels?: string[];
  /** Only handle messages that @-mention the bot. */
  requireMention?: boolean;
  /** Only handle messages from these authors (user ids or usernames); empty/undefined = anyone. */
  fromUsers?: string[];
}

/** Pure filter: should this message wake the agent? (unit-tested) */
export function shouldHandle(
  msg: DiscordMessage,
  botUserId: string,
  channelName: string | undefined,
  opts: DiscordFilterOptions,
): boolean {
  if (msg.author.bot || msg.author.id === botUserId) return false;
  // The author gate runs before the model is ever called — messages from
  // unlisted authors are dropped here and never reach the provider.
  if (
    opts.fromUsers?.length &&
    !opts.fromUsers.some((u) => u === msg.author.id || u === msg.author.username)
  ) return false;
  if (!msg.content.trim()) return false;
  if (opts.channels?.length) {
    const match = opts.channels.includes(msg.channel_id) ||
      (channelName !== undefined && opts.channels.includes(channelName));
    if (!match) return false;
  }
  if (opts.requireMention && !msg.mentions?.some((m) => m.id === botUserId)) return false;
  return true;
}

/** Options for {@linkcode DiscordTrigger}. */
export interface DiscordTriggerOptions extends DiscordFilterOptions {
  /** Discord bot token. */
  token: string;
  /** Post replies into this channel id instead of the source channel. */
  replyChannel?: string;
  /** Suppress the reply when the agent answers with the NO_REPLY sentinel (or nothing). */
  allowSilence?: boolean;
}

/**
 * Listens to the Discord gateway and wakes the agent on matching messages,
 * replying in the source channel (or a configured reply channel).
 */
export class DiscordTrigger implements Trigger {
  /** Trigger name, used as the event's `trigger` field. */
  readonly name = "discord";
  #opts: DiscordTriggerOptions;
  #ws?: WebSocket;
  #heartbeat?: ReturnType<typeof setInterval>;
  #stopped = false;
  #botUserId = "";
  #channelNames = new Map<string, string | undefined>();
  #reconnectDelayMs = 1_000;

  /** Create the trigger; nothing connects until {@linkcode start}. */
  constructor(opts: DiscordTriggerOptions) {
    this.#opts = opts;
  }

  async #api(path: string, init?: RequestInit): Promise<Response> {
    return await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${this.#opts.token}`,
        "content-type": "application/json",
        ...init?.headers,
      },
    });
  }

  async #channelName(channelId: string): Promise<string | undefined> {
    if (!this.#channelNames.has(channelId)) {
      const res = await this.#api(`/channels/${channelId}`);
      const name = res.ok ? (await res.json()).name : undefined;
      if (!res.ok) await res.body?.cancel();
      this.#channelNames.set(channelId, name);
    }
    return this.#channelNames.get(channelId);
  }

  async #reply(msg: DiscordMessage, result: RunResult) {
    const reply = (result.reply ?? "").trim();

    // The agent had nothing to say — with allow_silence, say nothing.
    if (this.#opts.allowSilence && (reply === NO_REPLY || reply === "")) return;

    // Where to post: a dedicated reply channel, else the source channel.
    const target = this.#opts.replyChannel ?? msg.channel_id;
    const inSourceChannel = target === msg.channel_id;

    let body = reply || `(${result.status})`;
    if (!inSourceChannel) {
      // Out-of-channel replies carry their own context: quote the triggering
      // message and link back (message_reference only works in-channel).
      const link = msg.guild_id
        ? ` ([jump](https://discord.com/channels/${msg.guild_id}/${msg.channel_id}/${msg.id}))`
        : "";
      const quoted = msg.content.replace(/\n/g, "\n> ");
      body = `On this message${link}:\n> ${quoted}\n\n${body}`;
    }

    for (const part of splitMessage(body)) {
      const res = await this.#api(`/channels/${target}/messages`, {
        method: "POST",
        body: JSON.stringify(
          inSourceChannel
            ? {
              content: part,
              message_reference: { message_id: msg.id, fail_if_not_exists: false },
            }
            : { content: part },
        ),
      });
      if (!res.ok) {
        console.error(`discord: reply failed (${res.status}): ${await res.text()}`);
      } else {
        await res.body?.cancel();
      }
    }
  }

  /** Connect to the gateway; matching messages emit events and get replies. */
  async start(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void> {
    const res = await this.#api("/gateway/bot");
    if (!res.ok) {
      throw new Error(`discord: cannot reach gateway (${res.status}) — check the bot token`);
    }
    const { url } = await res.json();
    this.#connect(`${url}?v=10&encoding=json`, emit);
  }

  #connect(gatewayUrl: string, emit: (event: AgentEvent) => Promise<RunResult>) {
    if (this.#stopped) return;
    const ws = new WebSocket(gatewayUrl);
    this.#ws = ws;

    ws.onmessage = async (raw) => {
      const payload = JSON.parse(raw.data);
      switch (payload.op) {
        case 10: { // HELLO → heartbeat + identify
          clearInterval(this.#heartbeat);
          this.#heartbeat = setInterval(
            () => ws.send(JSON.stringify({ op: 1, d: null })),
            payload.d.heartbeat_interval,
          );
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token: this.#opts.token,
              intents: INTENTS,
              properties: { os: "linux", browser: "looped-af", device: "looped-af" },
            },
          }));
          break;
        }
        case 0: { // dispatch
          if (payload.t === "READY") {
            this.#botUserId = payload.d.user.id;
            this.#reconnectDelayMs = 1_000;
            console.log(`discord trigger connected as ${payload.d.user.username}`);
          }
          if (payload.t === "MESSAGE_CREATE") {
            const msg = payload.d as DiscordMessage;
            const channelName = this.#opts.channels?.length
              ? await this.#channelName(msg.channel_id)
              : undefined;
            if (!shouldHandle(msg, this.#botUserId, channelName, this.#opts)) break;
            const result = await emit({
              id: msg.id,
              trigger: this.name,
              input: msg.content,
              conversationKey: `discord:${msg.channel_id}`,
            });
            await this.#reply(msg, result);
          }
          break;
        }
        case 7: // RECONNECT
        case 9: // INVALID SESSION
          ws.close();
          break;
      }
    };

    ws.onclose = () => {
      clearInterval(this.#heartbeat);
      if (this.#stopped) return;
      const delay = this.#reconnectDelayMs;
      this.#reconnectDelayMs = Math.min(delay * 2, 60_000);
      console.log(`discord: gateway closed, reconnecting in ${delay}ms`);
      setTimeout(() => this.#connect(gatewayUrl, emit), delay);
    };
    ws.onerror = () => ws.close();
  }

  /** Close the gateway connection and stop reconnecting. */
  stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#heartbeat);
    this.#ws?.close();
    return Promise.resolve();
  }
}
