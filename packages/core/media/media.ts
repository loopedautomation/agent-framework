import type { ImageContent } from "../providers/types.ts";

/**
 * Attachments arrive on every channel and none of them agree on how. Discord
 * hands back a CDN url, Slack a token-gated one, Telegram a file id to resolve,
 * IMAP the bytes inline. This module is where those differences end: a trigger
 * turns whatever it has into {@linkcode Attachment}s, calls
 * {@linkcode resolveAttachments}, and gets back the images the model can look
 * at plus a line of prose for everything it can't.
 *
 * Nothing downstream of a trigger learns where an image came from (Plan 14).
 */

/** The image formats every provider dialect accepts. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** One file that arrived with a message, before we know if the agent can read it. */
export interface Attachment {
  /** What the channel called it; used in the prose line when it can't be read. */
  filename?: string;
  /** The media type the channel reported, if it reported one. */
  mediaType?: string;
  /** Size in bytes, when the channel says so before we fetch. */
  size?: number;
  /** Fetch the bytes. Called only for images inside the caps. */
  fetch: () => Promise<Uint8Array>;
}

/** The caps an agent's `limits:` block puts on what an image may cost. */
export interface MediaLimits {
  /** Largest image to fetch. A bigger one is described rather than read. */
  maxImageBytes: number;
  /** How many images one message may carry into the context. */
  maxImagesPerMessage: number;
}

/** What a message's attachments came to: images to look at, and prose for the rest. */
export interface ResolvedMedia {
  /** Images within the caps, ready for the provider. */
  images: ImageContent[];
  /** One line per attachment the agent cannot look at, to append to the prompt. */
  notes: string[];
}

/** Whether the model can look at this media type. */
export function isImageType(mediaType: string | undefined): mediaType is ImageContent["mediaType"] {
  return IMAGE_TYPES.includes(mediaType as ImageContent["mediaType"]);
}

/** Bytes as a human reads them, for the prose line. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The line the agent sees in place of a file it cannot look at. An agent that
 * says "you sent me quarterly.pdf but I can't read PDFs" is useful; one that
 * saw nothing at all and says nothing is the bug this replaces.
 */
function describe(attachment: Attachment, why: string): string {
  const parts = [attachment.mediaType, attachment.size ? humanSize(attachment.size) : undefined]
    .filter((p) => p !== undefined);
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  return `[attachment: ${attachment.filename ?? "unnamed"}${detail} — ${why}]`;
}

/** Base64 without blowing the stack on a multi-megabyte image. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Fetch the images an agent is allowed to look at; describe everything else.
 *
 * An attachment is described rather than read when it isn't an image, when it
 * is bigger than the agent's cap, when the message already carries as many
 * images as the cap allows, or when fetching it fails. Every one of those is a
 * line in the prompt: the agent always knows what arrived, even when it can't
 * see it.
 */
export async function resolveAttachments(
  attachments: Attachment[],
  limits: MediaLimits,
): Promise<ResolvedMedia> {
  const images: ImageContent[] = [];
  const notes: string[] = [];

  for (const attachment of attachments) {
    if (!isImageType(attachment.mediaType)) {
      notes.push(describe(attachment, "not an image; this agent reads text and images"));
      continue;
    }
    if (attachment.size !== undefined && attachment.size > limits.maxImageBytes) {
      notes.push(
        describe(attachment, `over the ${humanSize(limits.maxImageBytes)} image limit — not read`),
      );
      continue;
    }
    if (images.length >= limits.maxImagesPerMessage) {
      notes.push(
        describe(attachment, `past the ${limits.maxImagesPerMessage}-image limit — not read`),
      );
      continue;
    }

    try {
      const bytes = await attachment.fetch();
      // The channel's reported size can be absent or a lie; the bytes are not.
      if (bytes.length > limits.maxImageBytes) {
        notes.push(
          describe(
            attachment,
            `over the ${humanSize(limits.maxImageBytes)} image limit — not read`,
          ),
        );
        continue;
      }
      images.push({ mediaType: attachment.mediaType, data: toBase64(bytes) });
    } catch (err) {
      // A failed fetch is the agent's business: it explains a reply that would
      // otherwise ignore the thing the user was asking about.
      notes.push(describe(attachment, `could not be fetched (${(err as Error).message})`));
    }
  }

  return { images, notes };
}

/** The text of a message plus the prose for anything the agent can't look at. */
export function withNotes(text: string, notes: string[]): string {
  if (!notes.length) return text;
  return [text, ...notes].filter((part) => part.trim()).join("\n");
}
