import { logError, logInfo, resolveAttachments, withNotes } from "@looped/core";
import type {
  AgentEvent,
  Attachment,
  CommandSpec,
  MediaLimits,
  RunResult,
  Trigger,
} from "@looped/core";
import { NO_REPLY, splitMessage } from "./text.ts";
import { SPEAK_MAX_CHARS, type VoiceEngines } from "./voice.ts";

// A deliberately minimal Telegram Bot API client: getMe, sendMessage, and one
// of two delivery transports. polling (the default) long-polls getUpdates —
// no library, no public endpoint (Plan 0, principle 8). webhook registers a
// setWebhook URL and serves inbound HTTPS deliveries instead, so the process
// can sleep between messages on scale-to-zero hosts: Telegram queues
// undelivered updates (~24h) and retries, and the retry is what wakes the
// host back up.
//
// Note: bots have privacy mode ON by default — in groups they only receive
// mentions and replies until it's disabled via @BotFather (/setprivacy).

const LIMIT = 4096; // Telegram's hard cap per message

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

/** A photo variant: Telegram renders one upload at several sizes and sends them all. */
export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; is_bot?: boolean; username?: string };
  text?: string;
  /** A photo's or document's text arrives here; `text` is empty on those messages. */
  caption?: string;
  /** Size variants of one photo, smallest first. */
  photo?: TelegramPhotoSize[];
  /** Anything sent "as a file" — including images, which keep their real mime type. */
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  audio?: {
    file_id: string;
    duration: number;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  video?: {
    file_id: string;
    duration: number;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
}

/** The text a message carries, wherever Telegram chose to put it. */
function messageText(msg: TelegramMessage): string | undefined {
  const text = (msg.text ?? msg.caption)?.trim();
  return text ? text : undefined;
}

/** Whether the message carries anything the agent should be told about. */
function hasMedia(msg: TelegramMessage): boolean {
  return Boolean(msg.photo?.length || msg.document || msg.voice || msg.audio || msg.video);
}

/**
 * The variants of a photo are the same picture at several resolutions; the
 * biggest one the caps allow is the one worth spending tokens on. Telegram
 * orders them smallest first, so walk back from the end. When none fits, the
 * smallest still goes through: {@linkcode resolveAttachments} turns it into an
 * honest "over the limit" line rather than dropping the photo in silence.
 */
export function pickPhoto(
  variants: TelegramPhotoSize[],
  maxBytes: number,
): TelegramPhotoSize | undefined {
  if (!variants.length) return undefined;
  const fits = variants.findLast((v) => v.file_size === undefined || v.file_size <= maxBytes);
  return fits ?? variants[0];
}

/**
 * Everything the message carried, as attachments the core resolver understands.
 * Voice, audio and video are handed over with their real media type and never
 * fetched — they are not images, so they come back as note lines and the agent
 * can say plainly that it cannot listen to or watch them (Plan 14 defers voice).
 */
export function telegramAttachments(
  msg: TelegramMessage,
  maxImageBytes: number,
  download: (fileId: string) => Promise<Uint8Array>,
): Attachment[] {
  const attachments: Attachment[] = [];

  const photo = msg.photo?.length ? pickPhoto(msg.photo, maxImageBytes) : undefined;
  if (photo) {
    // A photo has no name or mime on the wire: Telegram always re-encodes to JPEG.
    attachments.push({
      filename: `photo_${photo.file_unique_id}.jpg`,
      mediaType: "image/jpeg",
      size: photo.file_size,
      fetch: () => download(photo.file_id),
    });
  }

  const files = [msg.document, msg.voice, msg.audio, msg.video];
  for (const file of files) {
    if (!file) continue;
    attachments.push({
      filename: "file_name" in file ? file.file_name : undefined,
      mediaType: file.mime_type,
      size: file.file_size,
      fetch: () => download(file.file_id),
    });
  }

  return attachments;
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
  // A photo carries its words in `caption`, and often carries none at all —
  // requiring `text` here is what used to drop every image on the floor.
  const text = messageText(msg);
  if (!text && !hasMedia(msg)) return false;
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
    !(text ?? "").includes(`@${botUsername}`)
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
  /** How updates arrive: getUpdates long polling (default) or an inbound webhook. */
  transport?: "polling" | "webhook";
  /** Webhook transport: TCP port to listen on. */
  port?: number;
  /** Webhook transport: URL path Telegram POSTs updates to. */
  path?: string;
  /** Webhook transport: the externally reachable HTTPS base registered via setWebhook. */
  publicUrl?: string;
  /** Injectable for tests: 0 picks an ephemeral port. */
  onListen?: (addr: { port: number }) => void;
  /** Injectable for tests: a fake Bot API server stands in for api.telegram.org. */
  apiBase?: string;
  /** What an inbound image may cost; from the agent's `limits:` block. */
  media?: MediaLimits;
  /** Voice engines: transcribe incoming voice notes, and (with speak) voice the replies back. */
  voice?: VoiceEngines;
}

/** The schema's defaults, so a trigger built by hand still has a ceiling. */
const DEFAULT_MEDIA: MediaLimits = { maxImageBytes: 5_000_000, maxImagesPerMessage: 4 };

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
  #server?: Deno.HttpServer;

  /** Create the trigger; nothing polls until {@linkcode start}. */
  constructor(opts: TelegramTriggerOptions) {
    this.#opts = opts;
  }

  get #apiBase(): string {
    return this.#opts.apiBase ?? "https://api.telegram.org";
  }

  async #api(method: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    // FormData rides as multipart (sendVoice uploads); everything else as JSON.
    const form = body instanceof FormData;
    return await fetch(`${this.#apiBase}/bot${this.#opts.token}/${method}`, {
      method: "POST",
      headers: form ? undefined : { "content-type": "application/json" },
      body: form ? body : body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  }

  /**
   * Bytes of an uploaded file, in the two hops the Bot API insists on: getFile
   * resolves a file_id to a path that expires in an hour, and the path is
   * served from a different url shape than the JSON methods (/file/bot<token>/…
   * rather than /bot<token>/<method>), on the same host.
   */
  async #download(fileId: string): Promise<Uint8Array<ArrayBuffer>> {
    const res = await this.#api("getFile", { file_id: fileId });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`getFile failed (${res.status})`);
    }
    const path = (await res.json()).result?.file_path;
    if (!path) throw new Error("getFile returned no file_path");

    const file = await fetch(
      `${this.#apiBase}/file/bot${this.#opts.token}/${path}`,
    );
    if (!file.ok) {
      await file.body?.cancel();
      throw new Error(`file download failed (${file.status})`);
    }
    return new Uint8Array(await file.arrayBuffer());
  }

  /** The prompt text and the images for one message: caption, files, and honesty about the rest. */
  async #media(msg: TelegramMessage) {
    const limits = this.#opts.media ?? DEFAULT_MEDIA;

    // With voice engines, a voice note becomes the prompt itself; without
    // them it stays an attachment and resolves to an honest "can't listen"
    // note below. A failed transcription becomes a note line the same way.
    const voice = this.#opts.voice && msg.voice ? msg.voice : undefined;
    const notes: string[] = [];
    let transcript: string | undefined;
    if (voice) {
      try {
        transcript = await this.#opts.voice!.transcribe({
          audio: await this.#download(voice.file_id),
          mimeType: voice.mime_type ?? "audio/ogg",
          durationSecs: voice.duration,
        });
      } catch (err) {
        notes.push(`[voice message — transcription failed (${(err as Error).message})]`);
      }
    }

    const attachments = telegramAttachments(
      voice ? { ...msg, voice: undefined } : msg, // a transcribed note is handled, not an attachment
      limits.maxImageBytes,
      (fileId) => this.#download(fileId),
    );
    const resolved = await resolveAttachments(attachments, limits);
    notes.push(...resolved.notes);

    // An image with no caption is still a message; an empty prompt would leave
    // the model guessing why it was woken at all.
    const text = transcript ?? messageText(msg) ??
      (resolved.images.length ? "(an image arrived with no caption)" : "");
    return {
      input: withNotes(text, notes),
      images: resolved.images,
      asVoice: transcript !== undefined,
    };
  }

  /** Speak the reply and post it as a voice note; false hands the reply back to the text path. */
  async #sendVoiceReply(msg: TelegramMessage, text: string): Promise<boolean> {
    try {
      const clip = await this.#opts.voice!.speak!(text);
      const form = new FormData();
      form.append("chat_id", String(msg.chat.id));
      form.append("voice", new Blob([clip.audio], { type: clip.mimeType }), "voice.ogg");
      if (clip.durationSecs) form.append("duration", String(Math.round(clip.durationSecs)));
      form.append(
        "reply_parameters",
        JSON.stringify({ message_id: msg.message_id, allow_sending_without_reply: true }),
      );
      const res = await this.#api("sendVoice", form);
      if (!res.ok) {
        logError(`telegram: sendVoice failed (${res.status}): ${await res.text()}`);
        return false;
      }
      await res.body?.cancel();
      return true;
    } catch (err) {
      logError(`telegram: voice reply failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Proactive send (agent-created schedules): "telegram:<chatId>" keys are ours. */
  async deliver(conversationKey: string, text: string): Promise<boolean> {
    const match = conversationKey.match(/^telegram:(.+)$/);
    if (!match) return false;
    for (const part of splitMessage(text, LIMIT)) {
      const res = await this.#api("sendMessage", { chat_id: match[1], text: part });
      if (!res.ok) {
        logError(`telegram: deliver failed (${res.status}): ${await res.text()}`);
      } else {
        await res.body?.cancel();
      }
    }
    return true;
  }

  async #reply(msg: TelegramMessage, result: RunResult, asVoice = false) {
    const reply = (result.reply ?? "").trim();

    // The agent had nothing to say — with allow_silence, say nothing.
    if (this.#opts.allowSilence && (reply === NO_REPLY || reply === "")) return;

    // Where to post: a dedicated reply chat, else the source chat.
    const target = this.#opts.replyChat ?? msg.chat.id;
    const inSourceChat = String(target) === String(msg.chat.id);

    // A voice note gets a voice note back when speak is configured. Failures
    // and replies too long to speak fall through to the text path; replies
    // routed to another chat stay text, since they quote their context.
    if (
      asVoice && this.#opts.voice?.speak && inSourceChat &&
      reply !== "" && reply.length <= SPEAK_MAX_CHARS &&
      await this.#sendVoiceReply(msg, reply)
    ) return;

    let body = reply || `(${result.status})`;
    if (!inSourceChat) {
      // Out-of-chat replies carry their own context: quote the triggering
      // message and link back (supergroup ids are -100<internal>, which
      // t.me/c/<internal>/<message_id> links to).
      const id = String(msg.chat.id);
      const link = id.startsWith("-100") ? `\nhttps://t.me/c/${id.slice(4)}/${msg.message_id}` : "";
      const quoted = (messageText(msg) ?? "(no text)").replace(/\n/g, "\n> ");
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
        logError(`telegram: reply failed (${res.status}): ${await res.text()}`);
      } else {
        await res.body?.cancel();
      }
    }
  }

  /** Verify the token and start the configured transport: poll loop or webhook server. */
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
        logError(`telegram: setMyCommands failed (${set.status}): ${await set.text()}`);
      } else {
        await set.body?.cancel();
      }
    }
    if (this.#opts.transport === "webhook") {
      await this.#serve(me.username, emit);
      logInfo(`telegram trigger connected as @${me.username} (webhook)`);
      return;
    }
    // A leftover webhook registration makes getUpdates answer 409 forever;
    // deleting it is idempotent, so polling always clears its own path.
    const del = await this.#api("deleteWebhook");
    await del.body?.cancel();
    logInfo(`telegram trigger connected as @${me.username}`);
    this.#poll(me.username, emit); // long-poll loop runs for the service's lifetime
  }

  /** One matching update wakes the agent; shared by both transports. */
  #dispatch(
    update: { update_id: number; message?: TelegramMessage },
    botUsername: string,
    emit: (event: AgentEvent) => Promise<RunResult>,
  ) {
    const msg = update.message;
    if (!msg || !shouldHandle(msg, botUsername, this.#opts)) return;
    // Dispatch without awaiting: ordering within a chat is the service's job
    // (per-conversation FIFO), and holding the transport here would make one
    // long run block every other chat.
    this.#media(msg)
      .then(async ({ input, images, asVoice }) => {
        const result = await emit({
          id: String(update.update_id),
          trigger: this.name,
          input: stripCommandMention(input, botUsername),
          ...(images.length ? { images } : {}),
          conversationKey: `telegram:${msg.chat.id}`,
        });
        await this.#reply(msg, result, asVoice);
      })
      .catch((err) => {
        logError(`telegram: run failed: ${(err as Error).message}`);
      });
  }

  /**
   * Register the webhook and serve Telegram's deliveries. Each request must
   * carry the secret token minted here — Telegram echoes it back in the
   * X-Telegram-Bot-Api-Secret-Token header, and anything else is not Telegram.
   * Deliveries are acked immediately; the run happens after, because Telegram
   * redelivers slow responses and a run outlasts any HTTP timeout.
   */
  async #serve(botUsername: string, emit: (event: AgentEvent) => Promise<RunResult>) {
    const path = this.#opts.path ?? "/telegram";
    const secret = crypto.randomUUID();
    const url = (this.#opts.publicUrl ?? "").replace(/\/+$/, "") + path;
    const res = await this.#api("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message"],
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`telegram: setWebhook failed (${res.status}): ${detail}`);
    }
    await res.body?.cancel();

    this.#server = Deno.serve({
      port: this.#opts.port ?? 8080,
      onListen: this.#opts.onListen ?? ((addr) => {
        logInfo(`telegram trigger listening on :${addr.port}${path} for ${url}`);
      }),
    }, async (req) => {
      const reqUrl = new URL(req.url);
      if (reqUrl.pathname !== path) return Response.json({ error: "not found" }, { status: 404 });
      if (req.method !== "POST") {
        return Response.json({ error: "method not allowed" }, { status: 405 });
      }
      const token = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!timingSafeEqual(token, secret)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      let update: { update_id?: number; message?: TelegramMessage };
      try {
        update = await req.json();
      } catch {
        return Response.json({ error: "body must be JSON" }, { status: 400 });
      }
      if (typeof update.update_id === "number") {
        this.#dispatch({ update_id: update.update_id, message: update.message }, botUsername, emit);
      }
      return Response.json({ ok: true });
    });
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
          this.#dispatch(update, botUsername, emit);
        }
      } catch (err) {
        if (this.#stopped) return;
        const delay = this.#backoffMs;
        this.#backoffMs = Math.min(delay * 2, 60_000);
        logInfo(`telegram: poll error (${(err as Error).message}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /**
   * Stop the transport. The webhook registration is deliberately left in
   * place: Telegram queues undelivered updates (~24h) and retries, and on a
   * scale-to-zero host that retry is what boots the machine back up.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort?.abort();
    await this.#server?.shutdown();
  }
}
