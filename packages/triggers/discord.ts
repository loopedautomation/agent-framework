import type { AgentEvent, CommandSpec, RunResult, Trigger } from "@looped/core";
import { isSilence, NO_REPLY, splitMessage } from "./text.ts";

// A deliberately minimal Discord gateway client: identify, heartbeat,
// MESSAGE_CREATE, reconnect-with-backoff. No library — the framework's
// only job here is "message in, reply in thread", and a dependency-free
// ~200 lines keeps the container minimal (Plan 0, principle 8).

const API = "https://discord.com/api/v10";
// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

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

/**
 * What the filter knows about a channel (from `/channels/<id>`). A thread's
 * `channel_id` is the thread's own id and its `name` is the thread's title, so
 * the parent channel's id and name ride along — a filter naming `#general`
 * matches the threads under it too.
 */
export interface DiscordChannelInfo {
  name?: string;
  parentId?: string;
  parentName?: string;
}

/** Message filters shared by {@linkcode shouldHandle} and {@linkcode DiscordTriggerOptions}. */
export interface DiscordFilterOptions {
  /** Channel names or ids to listen in; empty/undefined = all channels. DMs always pass. */
  channels?: string[];
  /** Only handle messages that @-mention the bot (DMs always pass). */
  requireMention?: boolean;
  /** Only handle messages from these authors (user ids or usernames); empty/undefined = anyone. */
  fromUsers?: string[];
}

/** Pure filter: should this message wake the agent? (unit-tested) */
export function shouldHandle(
  msg: DiscordMessage,
  botUserId: string,
  channel: DiscordChannelInfo | undefined,
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
  // A DM addresses the bot by definition: the channel filter and the mention
  // gate only apply to guild messages (DMs carry no guild_id).
  const isDM = !msg.guild_id;
  if (!isDM && opts.channels?.length) {
    const ids = [msg.channel_id, channel?.name, channel?.parentId, channel?.parentName];
    if (!opts.channels.some((c) => ids.includes(c))) return false;
  }
  if (!isDM && opts.requireMention && !msg.mentions?.some((m) => m.id === botUserId)) return false;
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
  /** Show the typing indicator in the source channel while the agent works. */
  showTyping?: boolean;
  /** Slash commands to register as Discord application commands, so clients offer a native picker with descriptions. */
  commands?: CommandSpec[];
}

/** A Discord slash-command interaction (the fields this trigger reads). */
export interface DiscordInteraction {
  id: string;
  token: string;
  type: number;
  channel_id?: string;
  guild_id?: string;
  data?: { name?: string; options?: { name: string; value?: string }[] };
  member?: { user?: { id: string; username?: string } };
  user?: { id: string; username?: string };
}

/**
 * Fire `send` now and again every `intervalMs` until the returned stop
 * function is called. Discord's typing indicator expires after ~10 s, so the
 * default interval keeps it alive for the whole run.
 */
export function typingLoop(send: () => void, intervalMs = 8_000): () => void {
  send();
  const timer = setInterval(send, intervalMs);
  return () => clearInterval(timer);
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
  #applicationId = "";
  #channelInfos = new Map<string, DiscordChannelInfo | undefined>();
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

  async #channelInfo(channelId: string): Promise<DiscordChannelInfo | undefined> {
    if (!this.#channelInfos.has(channelId)) {
      const res = await this.#api(`/channels/${channelId}`);
      if (!res.ok) {
        await res.body?.cancel();
        this.#channelInfos.set(channelId, undefined);
      } else {
        const { name, parent_id, type } = await res.json();
        // A thread (types 10–12) reports its title as `name` and its channel
        // as `parent_id`; resolving the parent lets the channels filter match
        // either. For non-threads, parent_id is the category — not a channel
        // anyone lists in the filter, so it stays out of the info.
        const isThread = type === 10 || type === 11 || type === 12;
        const parentName = isThread && parent_id
          ? (await this.#channelInfo(parent_id))?.name
          : undefined;
        this.#channelInfos.set(channelId, {
          name,
          parentId: isThread ? parent_id : undefined,
          parentName,
        });
      }
    }
    return this.#channelInfos.get(channelId);
  }

  /** Proactive send (agent-created schedules): "discord:<channelId>" keys are ours. */
  async deliver(conversationKey: string, text: string): Promise<boolean> {
    const match = conversationKey.match(/^discord:(.+)$/);
    if (!match) return false;
    for (const part of splitMessage(text)) {
      const res = await this.#api(`/channels/${match[1]}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: part }),
      });
      if (!res.ok) {
        console.error(`discord: deliver failed (${res.status}): ${await res.text()}`);
      } else {
        await res.body?.cancel();
      }
    }
    return true;
  }

  async #reply(msg: DiscordMessage, result: RunResult) {
    const reply = (result.reply ?? "").trim();

    // The agent had nothing to say — with allow_silence, say nothing.
    if (this.#opts.allowSilence && isSilence(reply)) return;

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

  /**
   * Register the command list as global application commands (bulk overwrite,
   * so removed commands disappear too). Native registration is cosmetic —
   * autocomplete and descriptions in the client; failure only logs.
   */
  async #registerCommands() {
    const commands = this.#opts.commands;
    if (!commands?.length) return;
    this.#applicationId = await fetchApplicationId(this.#opts.token);
    const res = await this.#api(`/applications/${this.#applicationId}/commands`, {
      method: "PUT",
      body: JSON.stringify(commands.map((c) => ({
        name: c.name,
        description: c.description,
        type: 1, // CHAT_INPUT
        options: [{
          type: 3, // STRING
          name: "args",
          description: "Text passed to the command",
          required: false,
        }],
      }))),
    });
    if (!res.ok) {
      console.error(`discord: command registration failed (${res.status}): ${await res.text()}`);
    } else {
      await res.body?.cancel();
    }
  }

  /**
   * A native slash-command invocation arrives as an interaction, not a
   * message: acknowledge with a deferred reply ("thinking…"), run the agent
   * on the equivalent "/name args" text, then fill the deferred message in.
   */
  async #handleInteraction(
    interaction: DiscordInteraction,
    emit: (event: AgentEvent) => Promise<RunResult>,
  ) {
    if (interaction.type !== 2 || !interaction.data?.name) return; // APPLICATION_COMMAND only
    const user = interaction.member?.user ?? interaction.user;
    // The same author gate as messages, before the model is called.
    if (
      this.#opts.fromUsers?.length && user &&
      !this.#opts.fromUsers.some((u) => u === user.id || u === user.username)
    ) return;

    const ack = await this.#api(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({ type: 5 }), // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    });
    if (!ack.ok) {
      console.error(`discord: interaction ack failed (${ack.status}): ${await ack.text()}`);
      return;
    }
    await ack.body?.cancel();

    const args = interaction.data.options?.find((o) => o.name === "args")?.value ?? "";
    const result = await emit({
      id: interaction.id,
      trigger: this.name,
      input: `/${interaction.data.name}${args ? ` ${args}` : ""}`,
      conversationKey: interaction.channel_id ? `discord:${interaction.channel_id}` : undefined,
    });

    const webhook = `/webhooks/${this.#applicationId}/${interaction.token}`;
    const parts = splitMessage((result.reply ?? "").trim() || `(${result.status})`);
    for (const [i, part] of parts.entries()) {
      const res = i === 0
        ? await this.#api(`${webhook}/messages/@original`, {
          method: "PATCH",
          body: JSON.stringify({ content: part }),
        })
        : await this.#api(webhook, { method: "POST", body: JSON.stringify({ content: part }) });
      if (!res.ok) {
        console.error(`discord: interaction reply failed (${res.status}): ${await res.text()}`);
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
    await this.#registerCommands();
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
              // Explicit presence so the bot reads as online for as long as
              // the gateway connection is up.
              presence: { since: null, activities: [], status: "online", afk: false },
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
          if (payload.t === "INTERACTION_CREATE") {
            this.#handleInteraction(payload.d as DiscordInteraction, emit).catch((err) =>
              console.error(`discord: interaction handling failed: ${err}`)
            );
          }
          if (payload.t === "MESSAGE_CREATE") {
            const msg = payload.d as DiscordMessage;
            const channel = this.#opts.channels?.length
              ? await this.#channelInfo(msg.channel_id)
              : undefined;
            if (!shouldHandle(msg, this.#botUserId, channel, this.#opts)) break;
            const stopTyping = this.#opts.showTyping
              ? typingLoop(() => {
                this.#api(`/channels/${msg.channel_id}/typing`, { method: "POST" })
                  .then((res) => res.body?.cancel())
                  .catch(() => {}); // typing is cosmetic — never let it break the run
              })
              : undefined;
            try {
              const result = await emit({
                id: msg.id,
                trigger: this.name,
                input: msg.content,
                conversationKey: `discord:${msg.channel_id}`,
              });
              await this.#reply(msg, result);
            } finally {
              stopTyping?.();
            }
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
