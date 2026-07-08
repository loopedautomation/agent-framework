import type { AgentEvent, CommandSpec, RunResult, Trigger } from "@looped/core";
import { NO_REPLY, splitMessage } from "./text.ts";

// A deliberately minimal Telegram Bot API client: getMe, getUpdates
// long-polling, sendMessage. No library, no webhook, no public endpoint —
// the poll loop is the whole transport (Plan 0, principle 8).
//
// Note: bots have privacy mode ON by default — in groups they only receive
// mentions and replies until it's disabled via @BotFather (/setprivacy).

const LIMIT = 4096; // Telegram's hard cap per message

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; is_bot?: boolean; username?: string };
  text?: string;
}

/** Message filters shared by {@linkcode shouldHandle} and {@linkcode TelegramTriggerOptions}. */
export interface TelegramFilterOptions {
  /** Chat ids, group titles, or public @usernames to listen in; empty/undefined = all chats. */
  chats?: string[];
  /** Only handle messages that @-mention the bot (private chats always pass). */
  requireMention?: boolean;
  /** Only handle messages from these authors (user ids or usernames); empty/undefined = anyone. */
  fromUsers?: string[];
}

/** Pure filter: should this message wake the agent? (unit-tested) */
export function shouldHandle(
  msg: TelegramMessage,
  botUsername: string,
  opts: TelegramFilterOptions,
): boolean {
  const from = msg.from;
  if (!from || from.is_bot) return false;
  // The author gate runs before the model is ever called — messages from
  // unlisted authors are dropped here and never reach the provider.
  if (
    opts.fromUsers?.length &&
    !opts.fromUsers.some((u) => u === String(from.id) || u === from.username)
  ) return false;
  const text = msg.text?.trim();
  if (!text) return false;
  if (opts.chats?.length) {
    const match = opts.chats.some((c) =>
      c === String(msg.chat.id) || c === msg.chat.username || c === msg.chat.title ||
      (msg.chat.username !== undefined && c === `@${msg.chat.username}`)
    );
    if (!match) return false;
  }
  // A private chat addresses the bot by definition; mentions only gate groups.
  if (
    opts.requireMention && msg.chat.type !== "private" &&
    !msg.text!.includes(`@${botUsername}`)
  ) return false;
  return true;
}

/**
 * Telegram addresses commands per-bot in groups: the client sends
 * "/status@my_bot". Strip the suffix so the core parser sees "/status".
 * (pure, unit-tested)
 */
export function stripCommandMention(text: string, botUsername: string): string {
  const match = text.match(/^(\/[a-z0-9_]+)@(\S+)([\s\S]*)$/i);
  if (!match || match[2].toLowerCase() !== botUsername.toLowerCase()) return text;
  return match[1] + match[3];
}

/** Options for {@linkcode TelegramTrigger}. */
export interface TelegramTriggerOptions extends TelegramFilterOptions {
  /** Telegram bot token (from @BotFather). */
  token: string;
  /** Post replies into this chat id instead of the source chat. */
  replyChat?: string;
  /** Suppress the reply when the agent answers with the NO_REPLY sentinel (or nothing). */
  allowSilence?: boolean;
  /** Slash commands to register via setMyCommands, so clients offer a native picker with descriptions. */
  commands?: CommandSpec[];
}

/**
 * Long-polls the Telegram Bot API and wakes the agent on matching messages,
 * replying in the source chat (or a configured reply chat).
 */
export class TelegramTrigger implements Trigger {
  /** Trigger name, used as the event's `trigger` field. */
  readonly name = "telegram";
  #opts: TelegramTriggerOptions;
  #stopped = false;
  #abort?: AbortController;
  #backoffMs = 1_000;

  /** Create the trigger; nothing polls until {@linkcode start}. */
  constructor(opts: TelegramTriggerOptions) {
    this.#opts = opts;
  }

  async #api(method: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    return await fetch(`https://api.telegram.org/bot${this.#opts.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  }

  async #reply(msg: TelegramMessage, result: RunResult) {
    const reply = (result.reply ?? "").trim();

    // The agent had nothing to say — with allow_silence, say nothing.
    if (this.#opts.allowSilence && (reply === NO_REPLY || reply === "")) return;

    // Where to post: a dedicated reply chat, else the source chat.
    const target = this.#opts.replyChat ?? msg.chat.id;
    const inSourceChat = String(target) === String(msg.chat.id);

    let body = reply || `(${result.status})`;
    if (!inSourceChat) {
      // Out-of-chat replies carry their own context: quote the triggering
      // message and link back (supergroup ids are -100<internal>, which
      // t.me/c/<internal>/<message_id> links to).
      const id = String(msg.chat.id);
      const link = id.startsWith("-100") ? `\nhttps://t.me/c/${id.slice(4)}/${msg.message_id}` : "";
      const quoted = (msg.text ?? "").replace(/\n/g, "\n> ");
      body = `On this message:${link}\n> ${quoted}\n\n${body}`;
    }

    for (const part of splitMessage(body, LIMIT)) {
      const res = await this.#api("sendMessage", {
        chat_id: target,
        text: part,
        ...(inSourceChat
          ? { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }
          : {}),
      });
      if (!res.ok) {
        console.error(`telegram: reply failed (${res.status}): ${await res.text()}`);
      } else {
        await res.body?.cancel();
      }
    }
  }

  /** Verify the token and start the getUpdates long-poll loop. */
  async start(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void> {
    const res = await this.#api("getMe");
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`telegram: getMe failed (${res.status}) — check the bot token`);
    }
    const me = (await res.json()).result;
    if (this.#opts.commands?.length) {
      // Native registration is cosmetic (autocomplete + descriptions in the
      // client); the plain-text parser is the real path, so failure only logs.
      const set = await this.#api("setMyCommands", {
        commands: this.#opts.commands.map((c) => ({
          command: c.name,
          description: c.description,
        })),
      });
      if (!set.ok) {
        console.error(`telegram: setMyCommands failed (${set.status}): ${await set.text()}`);
      } else {
        await set.body?.cancel();
      }
    }
    console.log(`telegram trigger connected as @${me.username}`);
    this.#poll(me.username, emit); // long-poll loop runs for the service's lifetime
  }

  async #poll(botUsername: string, emit: (event: AgentEvent) => Promise<RunResult>) {
    let offset = 0;
    while (!this.#stopped) {
      this.#abort = new AbortController();
      try {
        const res = await this.#api("getUpdates", {
          offset,
          timeout: 50,
          allowed_updates: ["message"],
        }, this.#abort.signal);
        if (!res.ok) {
          await res.body?.cancel();
          throw new Error(`getUpdates failed (${res.status})`);
        }
        const updates: { update_id: number; message?: TelegramMessage }[] =
          (await res.json()).result ?? [];
        this.#backoffMs = 1_000;
        for (const update of updates) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (!msg || !shouldHandle(msg, botUsername, this.#opts)) continue;
          const result = await emit({
            id: String(update.update_id),
            trigger: this.name,
            input: stripCommandMention(msg.text!, botUsername),
            conversationKey: `telegram:${msg.chat.id}`,
          });
          await this.#reply(msg, result);
        }
      } catch (err) {
        if (this.#stopped) return;
        const delay = this.#backoffMs;
        this.#backoffMs = Math.min(delay * 2, 60_000);
        console.log(`telegram: poll error (${(err as Error).message}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /** Stop the poll loop and abort the in-flight getUpdates request. */
  stop(): Promise<void> {
    this.#stopped = true;
    this.#abort?.abort();
    return Promise.resolve();
  }
}
