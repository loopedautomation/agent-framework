import {
  BodyTooLargeError,
  logError,
  logInfo,
  readCapped,
  resolveAttachments,
  type Store,
  timingSafeEqual,
  withNotes,
} from "@looped/core";
import type { AgentEvent, Attachment, MediaLimits, RunResult, Trigger } from "@looped/core";
import { NO_REPLY, replyModality, splitMessage } from "./text.ts";
import { SPEAK_MAX_CHARS, type VoiceEngines } from "./voice.ts";

// A deliberately minimal WhatsApp Cloud API client: a typed fetch over the six
// Graph calls this channel actually makes, no SDK (Plan 0, principle 8). Meta's
// own Node SDK has been archived since 2023 and the community ones pin Graph
// versions on their own schedule; we pin ours in config.
//
// Read the eligibility section of docs/whatsapp.mdx before this file. Meta's
// Business Solution Terms forbid the WhatsApp Business Platform being used to
// provide a general-purpose AI assistant as the primary functionality. This
// channel exists so a business can run *its own* assistant under *its own*
// WABA; the framework never brokers a number and never fronts many agents
// behind one sender.
//
// The On-Premises API is gone (sunset 2025-10-23), so there is one transport:
// an inbound webhook on a public HTTPS URL. There is no long-poll and no
// Socket Mode equivalent — an agent behind a laptop NAT wants Telegram.

/** Hard cap on a WhatsApp text message body. */
export const WHATSAPP_LIMIT = 4096;

/** The Graph API version this build was written against. Bumped deliberately. */
export const DEFAULT_GRAPH_VERSION = "v26.0";

/** How long an inbound message keeps free-form replies open. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A free-entry-point conversation (Click-to-WhatsApp ad, Page CTA) opens a longer window. */
export const FREE_ENTRY_WINDOW_MS = 72 * 60 * 60 * 1000;

/** Meta retries an undelivered webhook for up to seven days; one more, so the table outlives them. */
const RETRY_WINDOW_DAYS = 8;

/** How many wamids the store-less fallback remembers before evicting the oldest. */
const MEMORY_SEEN_MAX = 5_000;

/**
 * Ceiling on a single webhook delivery. Meta batches messages into one POST,
 * but the payloads are small JSON; the body is read before the signature can
 * be checked, so this is what stops an unauthenticated POST from being
 * admitted to memory in the first place.
 */
const MAX_WEBHOOK_BYTES = 1_000_000;

/** Ceiling on an inbound voice note, matching WhatsApp's own 16 MB audio cap. */
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

/** Hosts Graph serves media bytes from, and the only ones the token is sent to. */
const MEDIA_HOSTS = ["lookaside.fbsbx.com", "mmg.whatsapp.net"];

/** A media object on an inbound message: WhatsApp sends an id, never bytes. */
export interface WhatsAppMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
  /** Audio only: true for a voice note, false for a music file sent as audio. */
  voice?: boolean;
}

/** An inbound message, as it arrives inside `value.messages[]`. */
export interface WhatsAppMessage {
  /** The wamid — globally unique, and what dedup keys on. */
  id: string;
  /** The sender's phone number in international format, no `+`. */
  from: string;
  /** Unix seconds, as a string. */
  timestamp?: string;
  type: string;
  text?: { body: string };
  image?: WhatsAppMedia;
  audio?: WhatsAppMedia;
  video?: WhatsAppMedia;
  document?: WhatsAppMedia;
  sticker?: WhatsAppMedia;
  /** Present when the conversation started from a Click-to-WhatsApp ad or Page CTA. */
  referral?: { source_type?: string; source_id?: string; headline?: string };
  errors?: WhatsAppError[];
}

/** Graph's error shape, which turns up at three levels of a webhook payload. */
export interface WhatsAppError {
  code?: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}

/** A delivery receipt: sent/delivered/read/failed for a message we sent. */
export interface WhatsAppStatus {
  id: string;
  status: string;
  recipient_id?: string;
  errors?: WhatsAppError[];
}

/** The `value` of a `messages` change: inbound messages, delivery receipts, or errors. */
export interface WhatsAppValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id?: string }[];
  messages?: WhatsAppMessage[];
  statuses?: WhatsAppStatus[];
  errors?: WhatsAppError[];
}

/** A whole webhook delivery. Meta fans one event out to every subscribed app. */
export interface WhatsAppWebhook {
  object?: string;
  entry?: { id?: string; changes?: { field?: string; value?: WhatsAppValue }[] }[];
}

/** Inputs for {@linkcode verifyMetaSignature}. */
export interface MetaVerifyOptions {
  /** The Meta app secret (from the app dashboard), which signs every delivery. */
  appSecret: string;
  /** The X-Hub-Signature-256 header: `sha256=<hex>`. */
  signature: string;
  /** The raw request body — the exact bytes, before any parse. */
  body: Uint8Array;
}

/**
 * Verify a Cloud API webhook: HMAC-SHA256 over the *unparsed* body with the
 * Meta app secret, hex-encoded, compared timing-safe against the
 * X-Hub-Signature-256 header.
 *
 * The body is bytes and never an object on purpose. Parsing JSON and
 * re-serializing it changes whitespace and key order, which changes the
 * digest, which is how integrations end up "fixing" this by not checking at
 * all. An unsigned request never reaches the parser.
 */
export async function verifyMetaSignature(opts: MetaVerifyOptions): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(opts.appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, opts.body as BufferSource);
  const expected = "sha256=" +
    [...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(opts.signature, expected);
}

/**
 * WhatsApp is not markdown. It has its own markup — `*bold*`, `_italic_`,
 * `~strike~`, triple-backtick monospace — with no headings, no markdown links
 * and no nested lists, and a model that has been talking to Discord all day
 * will happily emit `**bold**` and `## Heading` that render as literal
 * asterisks and hashes.
 *
 * This converts the constructs that actually turn up, and leaves everything
 * else alone: fenced code blocks pass through untouched (WhatsApp renders them
 * the same way), and a link becomes `text (url)` because WhatsApp autolinks
 * bare URLs anyway. (pure, unit-tested)
 */
export function toWhatsAppMarkup(text: string): string {
  // Verbatim regions the conversion must leave alone: a fenced block, a fence
  // that was never closed (what a reply truncated at max tokens looks like),
  // and inline code. Rewriting inside one would change content the agent
  // deliberately quoted.
  const parts = text.split(/(```[\s\S]*?```|```[\s\S]*$|`[^`\n]+`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // an odd index is a captured code region
      return part
        // Links first: the label may itself carry emphasis. The url run is
        // bounded because an unclosed "](" with no ")" after it would
        // otherwise backtrack across the rest of the message one character at
        // a time, from every starting position — quadratic, and on a long
        // quoted document that is seconds of blocked event loop.
        .replace(
          /!?\[([^\]\n]*)\]\(([^)\s]{1,2048})(?:\s+"[^"]*")?\)/g,
          (_m, label, url) => label ? `${label} (${url})` : url,
        )
        // Emphasis runs stay on one line. Letting them cross newlines means a
        // single stray "**" pairs with the next legitimate one and bolds
        // whole paragraphs between them.
        .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "*$1*")
        .replace(/__(?=\S)([^\n]*?\S)__/g, "*$1*")
        // Markdown strikethrough is doubled; WhatsApp's is single.
        .replace(/~~(?=\S)([^\n]*?\S)~~/g, "~$1~")
        // Headings come after emphasis, and a heading whose body already
        // carries markup keeps it. WhatsApp has one bold and no nesting, so
        // wrapping "*Q3 results* are in" in another pair of asterisks
        // produces "**Q3 results* are in*", which renders as neither.
        .replace(
          /^[ \t]*(#{1,6})[ \t]+(.+?)[ \t]*#*$/gm,
          (_m, _h, body: string) => body.includes("*") ? body : `*${body}*`,
        )
        // Remaining single `_x_` is already WhatsApp italic; `*x*` already bold.
        .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, "$1*$2*")
        // A horizontal rule renders as three literal dashes; drop it.
        .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
        // Unordered list markers: WhatsApp renders "- " natively, "* " as bold soup.
        .replace(/^([ \t]*)[*+][ \t]+/gm, "$1- ");
    })
    .join("");
}

/** Marker characters WhatsApp reads as formatting, and treats literally when unpaired. */
const MARKERS = ["*", "_", "~"] as const;

/**
 * Close every formatting run a split left hanging, and reopen it on the next
 * part.
 *
 * {@linkcode splitMessage} cuts on line boundaries and knows nothing about
 * markup, so a reply long enough to split can end one message mid-`*bold*` and
 * start the next with the orphaned half. WhatsApp renders an unpaired marker
 * as a literal asterisk, and a torn ``` fence is worse: a raw fence in one
 * message and unformatted code in the next. Counting markers per part and
 * balancing at the seam is enough, because the conversion above has already
 * confined every run to a single line. (pure, unit-tested)
 */
export function balanceMarkup(parts: string[]): string[] {
  const out = [...parts];
  for (let i = 0; i < out.length - 1; i++) {
    // A fence carries across the seam whole, so it is closed and reopened
    // before the single-character markers are counted.
    if ((out[i].match(/```/g) ?? []).length % 2 === 1) {
      out[i] += "\n```";
      out[i + 1] = "```\n" + out[i + 1];
      continue;
    }
    for (const marker of MARKERS) {
      const outside = out[i].split(/```[\s\S]*?```|`[^`\n]+`/).join("");
      const count = outside.split(marker).length - 1;
      if (count % 2 === 1) {
        out[i] += marker;
        out[i + 1] = marker + out[i + 1];
      }
    }
  }
  return out;
}

/**
 * Digits only, so `+263 77 123 4567`, `263771234567` and `(263) 771234567` are
 * one number. WhatsApp reports `from` as digits with no `+`; humans write
 * config the other way. (pure, unit-tested)
 */
export function normalizeNumber(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Pure filter: should this message wake the agent? The allow-list runs before
 * the model is ever called — an unlisted number reaching the model is not just
 * tokens, it is a stranger holding the business's phone number.
 *
 * There is no `require_mention` or `chats` analogue: Cloud API has no group
 * messaging for businesses, so every conversation is one person and one
 * business number, and both filters would be furniture. (unit-tested)
 */
export function shouldHandle(msg: WhatsAppMessage, fromNumbers?: string[]): boolean {
  if (!msg.id || !msg.from) return false;
  if (fromNumbers?.length) {
    const from = normalizeNumber(msg.from);
    if (!fromNumbers.some((n) => normalizeNumber(n) === from)) return false;
  }
  // Unsupported types (contacts, location, reactions, system messages) carry
  // nothing to act on; waking a run for them would spend a model call on air.
  return Boolean(messageText(msg) || mediaOf(msg));
}

/** The text a message carries, wherever WhatsApp chose to put it. */
function messageText(msg: WhatsAppMessage): string | undefined {
  const text = (msg.text?.body ?? msg.image?.caption ?? msg.video?.caption ??
    msg.document?.caption)?.trim();
  return text ? text : undefined;
}

/** The single media object a message carries, if any. */
function mediaOf(
  msg: WhatsAppMessage,
):
  | { media: WhatsAppMedia; kind: "image" | "audio" | "video" | "document" | "sticker" }
  | undefined {
  if (msg.image) return { media: msg.image, kind: "image" };
  if (msg.audio) return { media: msg.audio, kind: "audio" };
  if (msg.video) return { media: msg.video, kind: "video" };
  if (msg.document) return { media: msg.document, kind: "document" };
  if (msg.sticker) return { media: msg.sticker, kind: "sticker" };
  return undefined;
}

/**
 * Every inbound message a delivery carries, flattened out of the
 * entry/changes/value nesting and filtered to the `messages` field. Meta fans
 * one event out to every subscribed app and batches several messages into one
 * POST, so this is a list, not a message. (pure, unit-tested)
 */
export function inboundMessages(payload: WhatsAppWebhook): WhatsAppMessage[] {
  const messages: WhatsAppMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      messages.push(...(change.value?.messages ?? []));
    }
  }
  return messages;
}

/** Every `value` block of a delivery, for the error and status paths. */
export function changeValues(payload: WhatsAppWebhook): WhatsAppValue[] {
  const values: WhatsAppValue[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field === "messages" && change.value) values.push(change.value);
    }
  }
  return values;
}

/** One line per error, at whichever of the three levels Graph put it. */
function describeError(err: WhatsAppError): string {
  const detail = err.error_data?.details ?? err.message ?? err.title ?? "unknown error";
  return err.code === undefined ? detail : `${err.code}: ${detail}`;
}

/**
 * When the service window this inbound message opens runs out. A
 * free-entry-point conversation (an ad or Page CTA click) gets 72 hours and
 * covers templates too; everything else gets 24. (pure, unit-tested)
 */
export function windowEndsAt(msg: WhatsAppMessage, receivedAtMs: number): number {
  const span = msg.referral ? FREE_ENTRY_WINDOW_MS : SERVICE_WINDOW_MS;
  const stamped = Number(msg.timestamp) * 1000;
  // Trust our own clock over a stamp we did not set, unless the stamp is
  // plausible — a retried delivery can arrive days after it was sent.
  const base = Number.isFinite(stamped) && stamped > 0 && stamped <= receivedAtMs
    ? stamped
    : receivedAtMs;
  return base + span;
}

/**
 * Where a WhatsApp channel keeps the two facts it cannot recompute: which
 * wamids it has already handled, and when each contact's service window
 * closes. Both outlive a deploy — Meta retries for days, and a window opened
 * this morning still governs a scheduled send tonight — so the durable
 * implementation is the agent's own store.
 */
export interface WhatsAppState {
  /** Claim a wamid. True the first time, false for a retried delivery. */
  claim(wamid: string): boolean;
  /**
   * Give a claim back after the run behind it failed. Meta's delivery is
   * at-least-once even after a 200, so an unclaimed message gets another
   * chance at the next copy; a claim left behind makes the failure permanent.
   */
  release(wamid: string): void;
  /** When this contact's service window closes, in epoch ms; undefined if never opened. */
  windowEndsAt(waId: string): number | undefined;
  /** Record a window opening. */
  setWindowEndsAt(waId: string, atMs: number): void;
}

/**
 * The durable state: dedup rows and window stamps in the agent's SQLite file.
 * Pruning runs on claim, cheaply — the table only ever holds one retry window
 * of ids.
 */
export function storeState(store: Store, channel = "whatsapp"): WhatsAppState {
  let lastPruneMs = 0;
  return {
    claim(wamid) {
      const now = Date.now();
      if (now - lastPruneMs > 60 * 60 * 1000) {
        lastPruneMs = now;
        store.pruneEvents(channel, RETRY_WINDOW_DAYS);
        // A window row outlives its window by days; the longest one WhatsApp
        // grants is 72 hours, so anything untouched for four days is spent.
        // Without this, a public business number accumulates a permanent row
        // per stranger who ever messaged it.
        store.pruneChannelState(channel, 4);
      }
      return store.claimEvent(channel, wamid);
    },
    release(wamid) {
      store.releaseEvent(channel, wamid);
    },
    windowEndsAt(waId) {
      const raw = store.getChannelState(channel, `window:${waId}`);
      const at = raw === undefined ? NaN : Number(raw);
      return Number.isFinite(at) ? at : undefined;
    },
    setWindowEndsAt(waId, atMs) {
      store.setChannelState(channel, `window:${waId}`, String(atMs));
    },
  };
}

/**
 * The fallback when no store was handed over (a trigger built by hand, or a
 * test). It forgets everything on restart, which for dedup means a webhook
 * Meta retries across a deploy runs twice — hence the store being the default
 * wherever one exists.
 */
export function memoryState(): WhatsAppState {
  const seen = new Set<string>();
  const windows = new Map<string, number>();
  return {
    claim(wamid) {
      if (seen.has(wamid)) return false;
      // Insertion order is arrival order, so the oldest claim is the first
      // key. Evicting by age alone would free nothing on a number busy enough
      // to fill the table inside the retry window, which is exactly when the
      // table needs to stop growing.
      while (seen.size >= MEMORY_SEEN_MAX) {
        const oldest = seen.values().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      seen.add(wamid);
      return true;
    },
    release(wamid) {
      seen.delete(wamid);
    },
    windowEndsAt: (waId) => windows.get(waId),
    setWindowEndsAt: (waId, atMs) => void windows.set(waId, atMs),
  };
}

/** Options for {@linkcode WhatsAppTrigger}. */
export interface WhatsAppTriggerOptions {
  /** The sending number's id, from the WhatsApp Manager. */
  phoneNumberId: string;
  /** A system user access token with whatsapp_business_messaging. */
  token: string;
  /** The Meta app secret; every delivery's X-Hub-Signature-256 is verified with it. */
  appSecret: string;
  /** The handshake token we mint and Meta echoes back on GET. */
  verifyToken: string;
  /** TCP port to listen on. */
  port?: number;
  /** The externally reachable HTTPS base. Unlike Telegram's, this is never
   * registered for us — Meta's dashboard is where the callback URL is set —
   * so it exists to be logged at startup, ready to paste. */
  publicUrl?: string;
  /** URL path Meta POSTs deliveries to. */
  path?: string;
  /** Only handle messages from these numbers; omit for anyone who messages the business. */
  fromNumbers?: string[];
  /** Suppress the reply when the agent answers with the NO_REPLY sentinel (or nothing). */
  allowSilence?: boolean;
  /** Graph API version, pinned. Defaults to {@linkcode DEFAULT_GRAPH_VERSION}. */
  graphVersion?: string;
  /** Graph host override: 360dialog's pass-through, or a fake in tests. */
  apiBase?: string;
  /** Name of an approved template to fall back on for out-of-window sends. */
  outOfWindowTemplate?: string;
  /** Language code the fallback template is approved in. */
  outOfWindowTemplateLanguage?: string;
  /** Mark inbound messages read and show the typing bubble while the run works. */
  markRead?: boolean;
  /** Durable dedup and window state; defaults to an in-memory one. */
  state?: WhatsAppState;
  /** Injectable for tests: 0 picks an ephemeral port. */
  onListen?: (addr: { port: number }) => void;
  /** What an inbound image may cost; from the agent's `limits:` block. */
  media?: MediaLimits;
  /** Voice engines: transcribe incoming voice notes, and (with speak) voice the replies back. */
  voice?: VoiceEngines;
}

/** The schema's defaults, so a trigger built by hand still has a ceiling. */
const DEFAULT_MEDIA: MediaLimits = { maxImageBytes: 5_000_000, maxImagesPerMessage: 4 };

/**
 * Serves the WhatsApp Cloud API webhook and wakes the agent on inbound
 * messages, replying to the sender on the business's own number.
 */
export class WhatsAppTrigger implements Trigger {
  /** Trigger name, used as the event's `trigger` field. */
  readonly name = "whatsapp";
  #opts: WhatsAppTriggerOptions;
  #state: WhatsAppState;
  #server?: Deno.HttpServer;
  #inflight = new Set<Promise<void>>();

  /** Create the trigger; nothing listens until {@linkcode start}. */
  constructor(opts: WhatsAppTriggerOptions) {
    this.#opts = opts;
    this.#state = opts.state ?? memoryState();
  }

  get #graph(): string {
    const base = (this.#opts.apiBase ?? "https://graph.facebook.com").replace(/\/+$/, "");
    return `${base}/${this.#opts.graphVersion ?? DEFAULT_GRAPH_VERSION}`;
  }

  async #get(path: string): Promise<Response> {
    return await fetch(`${this.#graph}/${path}`, {
      headers: { authorization: `Bearer ${this.#opts.token}` },
    });
  }

  /** Every send is this call; only the `type` block differs. */
  async #send(body: Record<string, unknown>): Promise<Response> {
    return await fetch(`${this.#graph}/${this.#opts.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#opts.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
  }

  /** Post one text message, splitting at WhatsApp's cap. Throws on refusal. */
  async #sendText(to: string, text: string): Promise<void> {
    for (const part of balanceMarkup(splitMessage(toWhatsAppMarkup(text), WHATSAPP_LIMIT))) {
      const res = await this.#send({
        recipient_type: "individual",
        to,
        type: "text",
        // Link previews are Meta fetching every URL an agent emits; off by default.
        text: { preview_url: false, body: part },
      });
      if (!res.ok) {
        throw new Error(`send failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
      }
      await res.body?.cancel();
    }
  }

  /** Whether a media URL is somewhere we are willing to send the access token. */
  #mediaHostAllowed(host: string): boolean {
    if (MEDIA_HOSTS.includes(host)) return true;
    // An operator pointing api_base at an aggregator serves media from there
    // too, so their own host counts — and only theirs.
    try {
      return host === new URL(this.#opts.apiBase ?? "https://graph.facebook.com").hostname;
    } catch {
      return false;
    }
  }

  /**
   * Bytes of an inbound media object, in the two hops Graph insists on: the id
   * resolves to a signed URL that expires in about five minutes, and that URL
   * still needs the bearer header to download.
   *
   * `maxBytes` is the ceiling, and it is enforced twice. The lookup reports a
   * `file_size`, which makes the common refusal free, and the read is capped
   * regardless because that number is Graph's claim rather than a guarantee.
   * Without this the cap in `limits:` is applied after the bytes are already
   * resident: WhatsApp allows a 100 MB document, a document keeps its real
   * mime type, and an image sent as a file therefore walks straight past a
   * 5 MB image limit and into memory before anything measures it.
   */
  async #download(mediaId: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    // The id arrives inside a signed payload and is interpolated into a
    // request path. Graph ids are digits, so anything else is refused here
    // rather than sent.
    if (!/^\d{1,40}$/.test(mediaId)) throw new Error("media id is not a Graph id");

    const res = await this.#get(mediaId);
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`media lookup failed (${res.status})`);
    }
    const meta = await res.json();
    const url = meta?.url;
    if (!url) throw new Error("media lookup returned no url");
    const declared = Number(meta?.file_size);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`media is ${declared} bytes, over the ${maxBytes} limit`);
    }

    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new Error("media lookup returned a url that does not parse");
    }
    if (!this.#mediaHostAllowed(host)) {
      throw new Error(`media url pointed at unexpected host ${host}`);
    }

    const file = await fetch(url, { headers: { authorization: `Bearer ${this.#opts.token}` } });
    if (!file.ok) {
      await file.body?.cancel();
      throw new Error(`media download failed (${file.status})`);
    }
    try {
      return await readCapped(file.body, maxBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        throw new Error(`media is over the ${maxBytes} limit`);
      }
      throw err;
    }
  }

  /**
   * What the message carried, as attachments the core resolver understands.
   * Audio, video and documents are handed over with their real media type and
   * never fetched — they are not images, so they come back as note lines and
   * the agent can say plainly what it cannot read.
   */
  #attachments(msg: WhatsAppMessage, maxImageBytes: number): Attachment[] {
    const found = mediaOf(msg);
    if (!found) return [];
    const { media, kind } = found;
    const ext = (media.mime_type ?? "").split("/")[1]?.split(";")[0];
    return [{
      filename: media.filename ?? `${kind}_${media.id}${ext ? `.${ext}` : ""}`,
      mediaType: media.mime_type?.split(";")[0],
      // The webhook carries no size, so there is nothing for the resolver to
      // check before it fetches. The ceiling therefore travels with the fetch
      // itself, and a refusal comes back as a note the same way an oversized
      // image with a known size would.
      fetch: () => this.#download(media.id, maxImageBytes),
    }];
  }

  /** The prompt text and the images for one message: body, media, and honesty about the rest. */
  async #render(msg: WhatsAppMessage) {
    const limits = this.#opts.media ?? DEFAULT_MEDIA;
    const notes: string[] = [];
    for (const err of msg.errors ?? []) notes.push(`[whatsapp error — ${describeError(err)}]`);

    // With voice engines, a voice note becomes the prompt itself; without them
    // it stays an attachment and resolves to an honest "can't listen" note.
    const voiceNote = this.#opts.voice && msg.audio?.voice !== false ? msg.audio : undefined;
    let transcript: string | undefined;
    if (voiceNote) {
      try {
        transcript = await this.#opts.voice!.transcribe({
          audio: await this.#download(voiceNote.id, MAX_AUDIO_BYTES),
          mimeType: voiceNote.mime_type?.split(";")[0] ?? "audio/ogg",
        });
      } catch (err) {
        notes.push(`[voice message — transcription failed (${(err as Error).message})]`);
      }
    }

    const attachments = this.#attachments(
      transcript !== undefined ? { ...msg, audio: undefined } : msg,
      limits.maxImageBytes,
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

  /**
   * Mark the message read and raise the typing bubble in one call. Both are
   * cosmetic, so a failure only logs. The bubble clears on our reply or after
   * 25 seconds — shorter than many runs, so a slow agent still goes quiet
   * before it answers.
   */
  async #markRead(messageId: string): Promise<void> {
    try {
      const res = await this.#send({
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      });
      if (!res.ok) {
        logError(`whatsapp: mark read failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      } else {
        await res.body?.cancel();
      }
    } catch (err) {
      logError(`whatsapp: mark read failed: ${(err as Error).message}`);
    }
  }

  /** Upload bytes for an outbound send; Graph takes an id, never a URL we host. */
  async #upload(bytes: Uint8Array, mimeType: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([bytes as BlobPart], { type: mimeType }), filename);
    const res = await fetch(`${this.#graph}/${this.#opts.phoneNumberId}/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#opts.token}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`media upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const id = (await res.json())?.id;
    if (!id) throw new Error("media upload returned no id");
    return id as string;
  }

  /** Speak the reply and post it as a voice note; false hands the reply back to the text path. */
  async #sendVoiceReply(to: string, text: string): Promise<boolean> {
    try {
      const clip = await this.#opts.voice!.speak!(text);
      const id = await this.#upload(clip.audio, clip.mimeType, "reply.ogg");
      const res = await this.#send({
        recipient_type: "individual",
        to,
        type: "audio",
        audio: { id },
      });
      if (!res.ok) {
        logError(
          `whatsapp: voice reply failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
        );
        return false;
      }
      await res.body?.cancel();
      return true;
    } catch (err) {
      logError(`whatsapp: voice reply failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Proactive send (agent-created schedules, routed replies): `whatsapp:<wa_id>`
   * keys are ours.
   *
   * This is where the 24-hour service window stops being invisible. A reply to
   * an inbound message always lands inside the window that message opened; a
   * scheduled send fires hours later, into a window that may well have closed,
   * and free-form text outside it is a 400 from Graph.
   *
   * So: inside the window, a normal text. Outside it, the configured template
   * if the operator has one approved, and otherwise a throw that names the
   * reason. Silently dropping a scheduled message is worse than a red line in
   * the log.
   */
  async deliver(conversationKey: string, text: string): Promise<boolean> {
    const match = conversationKey.match(/^whatsapp:(.+)$/);
    if (!match) return false;
    const to = match[1];

    const endsAt = this.#state.windowEndsAt(to);
    if (endsAt !== undefined && Date.now() < endsAt) {
      await this.#sendText(to, text);
      return true;
    }

    const template = this.#opts.outOfWindowTemplate;
    if (!template) {
      throw new Error(
        `the 24-hour service window for ${to} is closed, so only a pre-approved template ` +
          `may be sent. Set out_of_window_template, or expect sends outside the window to ` +
          `be refused — https://docs.looped.sh/agent-framework/whatsapp#the-24-hour-window`,
      );
    }
    const res = await this.#send({
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: template,
        language: { code: this.#opts.outOfWindowTemplateLanguage ?? "en_US" },
        components: [{
          type: "body",
          // Graph refuses a template parameter containing a newline, a tab or
          // four consecutive spaces, and an agent's reply is almost always
          // multi-line. Collapsing whitespace is what keeps the fallback path
          // from failing on exactly the sends it exists to rescue.
          parameters: [{ type: "text", text: text.replace(/\s+/g, " ").trim().slice(0, 1024) }],
        }],
      },
    });
    if (!res.ok) {
      throw new Error(
        `out-of-window template "${template}" was refused (${res.status}): ` +
          `${(await res.text()).slice(0, 500)}`,
      );
    }
    await res.body?.cancel();
    logInfo(`whatsapp: window closed for ${to}, delivered via template "${template}"`);
    return true;
  }

  async #reply(msg: WhatsAppMessage, result: RunResult, asVoice: boolean) {
    // A leading __VOICE__/__TEXT__ marker overrides the default modality and is
    // stripped from the reply the recipient sees.
    const { mode, text: reply } = replyModality((result.reply ?? "").trim());

    // The agent had nothing to say — with allow_silence, say nothing.
    if (this.#opts.allowSilence && (reply === NO_REPLY || reply === "")) return;

    // A voice note gets a voice note back by default; __VOICE__ forces one and
    // __TEXT__ opts out. Failures and replies too long to speak fall through.
    const wantsVoice = mode === "voice" || (mode === undefined && asVoice);
    if (
      wantsVoice && this.#opts.voice?.speak &&
      reply !== "" && reply.length <= SPEAK_MAX_CHARS &&
      await this.#sendVoiceReply(msg.from, reply)
    ) return;

    try {
      await this.#sendText(msg.from, reply || `(${result.status})`);
    } catch (err) {
      logError(`whatsapp: reply failed: ${(err as Error).message}`);
    }
  }

  /**
   * One accepted message wakes the agent. The gates run in a fixed order and
   * all of them run before `emit`: an unlisted sender never reaches the model,
   * and a retried wamid never becomes a second billed run with a second reply.
   */
  #dispatch(msg: WhatsAppMessage, emit: (event: AgentEvent) => Promise<RunResult>) {
    if (!shouldHandle(msg, this.#opts.fromNumbers)) return;
    // Delivery is at-least-once, unordered, retried for days and fanned out to
    // every subscribed app. The wamid is the only thing standing between that
    // and a duplicate run.
    if (!this.#state.claim(msg.id)) {
      logInfo(`whatsapp: duplicate delivery of ${msg.id}, dropped`);
      return;
    }
    // Any inbound message opens the service window this contact's next
    // unprompted send will be measured against. Deliveries arrive unordered,
    // so a first-time copy of an old message can land after a fresh one; the
    // window only ever moves outwards, or a stale delivery would close a
    // conversation that is genuinely open and cost a template to reopen.
    const opensUntil = windowEndsAt(msg, Date.now());
    if (opensUntil > (this.#state.windowEndsAt(msg.from) ?? 0)) {
      this.#state.setWindowEndsAt(msg.from, opensUntil);
    }

    // Dispatch without awaiting: the delivery was already acked, and holding
    // here would make one long run block every other conversation. The
    // promise is tracked so shutdown can wait for it.
    const task = (async () => {
      if (this.#opts.markRead) await this.#markRead(msg.id);
      const { input, images, asVoice } = await this.#render(msg);
      const result = await emit({
        id: msg.id,
        trigger: this.name,
        input,
        ...(images.length ? { images } : {}),
        // WhatsApp has no threads: one number is one conversation, forever.
        conversationKey: `whatsapp:${msg.from}`,
      });
      await this.#reply(msg, result, asVoice);
    })().catch((err) => {
      // Hand the wamid back. Meta delivers at-least-once even after a 200, so
      // the next copy of this message gets a real attempt instead of being
      // dropped as a duplicate of the attempt that failed.
      this.#state.release(msg.id);
      logError(`whatsapp: run failed: ${(err as Error).message}`);
    });
    this.#inflight.add(task);
    task.finally(() => this.#inflight.delete(task));
  }

  /** Verify the credentials, then serve the webhook. */
  async start(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void> {
    const res = await this.#get(`${this.#opts.phoneNumberId}?fields=display_phone_number`);
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(
        `whatsapp: could not read phone number ${this.#opts.phoneNumberId} (${res.status}): ` +
          `${detail} — check phone_number_id and the access token`,
      );
    }
    const number = (await res.json())?.display_phone_number ?? this.#opts.phoneNumberId;
    this.#serve(emit);
    logInfo(`whatsapp trigger connected as ${number}`);
  }

  /**
   * Meta's webhook, both halves of it.
   *
   * GET is the verification handshake: Meta sends hub.mode, hub.verify_token
   * and hub.challenge, and we echo the challenge back as a raw body when the
   * token matches. Unlike Telegram's per-boot secret this token must survive
   * restarts, because Meta re-verifies whenever the subscription changes.
   *
   * POST is the delivery, in a fixed order: verify the signature over the raw
   * bytes, then parse, then ack, then run. A non-2xx puts the delivery back in
   * Meta's retry queue, and a run outlasts any webhook timeout — so the ack
   * goes out first and the work happens after it.
   */
  #serve(emit: (event: AgentEvent) => Promise<RunResult>) {
    const path = this.#opts.path ?? "/whatsapp";
    this.#server = Deno.serve({
      port: this.#opts.port ?? 8080,
      onListen: this.#opts.onListen ?? ((addr) => {
        // The callback URL is typed into Meta's dashboard by hand, so print
        // the exact string rather than leaving it to be reassembled.
        const callback = this.#opts.publicUrl
          ? `${this.#opts.publicUrl.replace(/\/+$/, "")}${path}`
          : `<public_url>${path}`;
        logInfo(`whatsapp trigger listening on :${addr.port}${path} — callback URL: ${callback}`);
      }),
    }, async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== path) return Response.json({ error: "not found" }, { status: 404 });

      if (req.method === "GET") {
        const params = url.searchParams;
        const challenge = params.get("hub.challenge") ?? "";
        if (
          params.get("hub.mode") === "subscribe" &&
          timingSafeEqual(params.get("hub.verify_token") ?? "", this.#opts.verifyToken)
        ) {
          logInfo("whatsapp: webhook verification handshake accepted");
          return new Response(challenge, { headers: { "content-type": "text/plain" } });
        }
        return Response.json({ error: "verification failed" }, { status: 403 });
      }

      if (req.method !== "POST") {
        return Response.json({ error: "method not allowed" }, { status: 405 });
      }

      // The signature is over the exact bytes: read them, verify, and only
      // then parse. Re-serializing a parsed body breaks the digest.
      //
      // Reading has to happen before there is any reason to trust the sender,
      // which is why it is capped. A chunked body declares no length, so the
      // count happens as the stream arrives and the sender is disconnected the
      // moment it runs over.
      let body: Uint8Array;
      try {
        body = await readCapped(req.body, MAX_WEBHOOK_BYTES);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          return Response.json({ error: "body too large" }, { status: 413 });
        }
        return Response.json({ error: "could not read body" }, { status: 400 });
      }
      const signature = req.headers.get("x-hub-signature-256") ?? "";
      const verified = signature.startsWith("sha256=") &&
        await verifyMetaSignature({ appSecret: this.#opts.appSecret, signature, body });
      if (!verified) return Response.json({ error: "invalid signature" }, { status: 401 });

      let payload: WhatsAppWebhook;
      try {
        payload = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return Response.json({ error: "body must be JSON" }, { status: 400 });
      }

      // Graph reports failures at three levels and nowhere else: a rejected
      // send only ever explains itself in a `failed` status.
      for (const value of changeValues(payload)) {
        for (const err of value.errors ?? []) {
          logError(`whatsapp: ${describeError(err)}`);
        }
        for (const status of value.statuses ?? []) {
          for (const err of status.errors ?? []) {
            logError(`whatsapp: message ${status.id} ${status.status} — ${describeError(err)}`);
          }
        }
      }

      for (const msg of inboundMessages(payload)) this.#dispatch(msg, emit);
      return Response.json({ ok: true });
    });
  }

  /**
   * Stop serving and wait for in-flight runs. The subscription stays
   * registered on Meta's side.
   *
   * The wait matters more here than the fire-and-forget dispatch suggests:
   * the delivery was acked the moment it arrived, so a run abandoned at
   * shutdown is a customer message that was accepted and never answered.
   */
  async stop(): Promise<void> {
    await this.#server?.shutdown();
    await Promise.allSettled([...this.#inflight]);
  }
}
