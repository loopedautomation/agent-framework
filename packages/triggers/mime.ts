// A deliberately minimal MIME parser for the pulled email transports: enough
// to turn the RFC 822 bytes an IMAP FETCH returns into headers, a text body
// and an attachment list. It handles the mail this feature targets
// (correspondence: multipart/alternative, base64, quoted-printable, RFC 2047
// subjects) and will be rough on exotic messages — the same v1 posture as the
// HTML tag-strip in email.ts.

/** What {@linkcode parseMime} extracts from a raw RFC 822 message. */
export interface ParsedMail {
  /** All top-level headers: lowercased names, unfolded values, first value wins. */
  headers: Record<string, string>;
  /** The From header, RFC 2047 words decoded. */
  from: string;
  /** The To header (single entry, addresses left comma-joined), decoded. */
  to: string[];
  /** The Subject header, decoded. */
  subject?: string;
  /** The Date header, verbatim. */
  date?: string;
  /** The Message-ID, angle brackets included. */
  messageId?: string;
  /** The first text/plain body found. */
  text?: string;
  /** The first text/html body found. */
  html?: string;
  /** Attachments, bytes included — an IMAP FETCH already carried them here. */
  attachments: ParsedAttachment[];
}

/** One attachment out of a parsed message. */
export interface ParsedAttachment {
  filename?: string;
  contentType?: string;
  /** Length of {@linkcode bytes} — what the file weighs, not what the wire carried. */
  size: number;
  /** The decoded file. */
  bytes: Uint8Array;
}

const latin1 = new TextDecoder("latin1");

function toBinaryString(raw: Uint8Array | string): string {
  // latin1 maps each byte to the code point of the same value, so the string
  // preserves the exact bytes for later per-part charset decoding.
  return typeof raw === "string" ? raw : latin1.decode(raw);
}

function splitHeadersBody(s: string): { head: string; body: string } {
  const m = s.match(/\r?\n\r?\n/);
  if (!m || m.index === undefined) return { head: s, body: "" };
  return { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) };
}

function parseHeaderBlock(head: string): Record<string, string> {
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  const headers: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!(name in headers)) headers[name] = line.slice(idx + 1).trim();
  }
  return headers;
}

/** A parameter from a structured header value, e.g. boundary= or charset=. */
function param(headerValue: string | undefined, name: string): string | undefined {
  const m = headerValue?.match(new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"));
  return m ? (m[1] ?? m[2]) : undefined;
}

function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  for (const cs of [charset, "utf-8", "latin1"]) {
    if (!cs) continue;
    try {
      return new TextDecoder(cs, { fatal: cs !== "latin1" }).decode(bytes);
    } catch {
      // unknown label or invalid bytes — fall through to the next candidate
    }
  }
  return latin1.decode(bytes);
}

function base64Bytes(s: string): Uint8Array {
  try {
    return Uint8Array.from(atob(s.replace(/[^A-Za-z0-9+/=]/g, "")), (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array(0);
  }
}

function quotedPrintableBytes(s: string, inHeader = false): Uint8Array {
  const src = s.replace(/=\r?\n/g, ""); // soft line breaks
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "=" && /^[0-9a-f]{2}$/i.test(src.slice(i + 1, i + 3))) {
      out.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (inHeader && c === "_") {
      out.push(0x20); // RFC 2047 Q-encoding: underscore is a space
    } else {
      out.push(c.charCodeAt(0) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Decode RFC 2047 encoded words (=?charset?B/Q?...?=) in a header value. */
export function decodeWords(value: string): string {
  // Whitespace between adjacent encoded words is not significant.
  return value.replace(/\?=\s+=\?/g, "?==?").replace(
    /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (_all, charset: string, enc: string, data: string) => {
      const bytes = enc.toLowerCase() === "b"
        ? base64Bytes(data)
        : quotedPrintableBytes(data, true);
      return decodeCharset(bytes, charset);
    },
  );
}

function decodeTransfer(body: string, encoding: string | undefined): Uint8Array {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "base64":
      return base64Bytes(body);
    case "quoted-printable":
      return quotedPrintableBytes(body);
    default: // 7bit, 8bit, binary, absent
      return Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff);
  }
}

function walkPart(headers: Record<string, string>, body: string, mail: ParsedMail): void {
  const contentType = headers["content-type"] ?? "text/plain";
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  const disposition = headers["content-disposition"];
  const filename = param(disposition, "filename") ?? param(contentType, "name");

  if (mediaType.startsWith("multipart/")) {
    const boundary = param(contentType, "boundary");
    if (!boundary) return;
    const chunks = body.split(`--${boundary}`);
    for (const chunk of chunks.slice(1)) {
      if (chunk.startsWith("--")) break; // closing delimiter
      const part = chunk.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      const { head, body: partBody } = splitHeadersBody(part);
      walkPart(parseHeaderBlock(head), partBody, mail);
    }
    return;
  }

  if (filename || disposition?.trim().toLowerCase().startsWith("attachment")) {
    const bytes = decodeTransfer(body, headers["content-transfer-encoding"]);
    mail.attachments.push({
      filename: filename ? decodeWords(filename) : undefined,
      contentType: mediaType,
      size: bytes.length,
      bytes,
    });
    return;
  }

  if (mediaType === "text/plain" || mediaType === "text/html") {
    const bytes = decodeTransfer(body, headers["content-transfer-encoding"]);
    const text = decodeCharset(bytes, param(contentType, "charset"));
    if (mediaType === "text/html") mail.html ??= text;
    else mail.text ??= text;
    return;
  }

  // Anything else without a filename still gets counted, so the rendered
  // input mentions that the message carried more than its text. An inline
  // image (a screenshot pasted into the mail) arrives on this branch.
  const bytes = decodeTransfer(body, headers["content-transfer-encoding"]);
  mail.attachments.push({ contentType: mediaType, size: bytes.length, bytes });
}

/** Parse a raw RFC 822 message into headers, bodies and attachment metadata. */
export function parseMime(raw: Uint8Array | string): ParsedMail {
  const { head, body } = splitHeadersBody(toBinaryString(raw));
  const headers = parseHeaderBlock(head);
  const mail: ParsedMail = {
    headers,
    from: decodeWords(headers["from"] ?? ""),
    to: headers["to"] ? [decodeWords(headers["to"])] : [],
    subject: headers["subject"] !== undefined ? decodeWords(headers["subject"]) : undefined,
    date: headers["date"],
    messageId: headers["message-id"]?.match(/<[^>]+>/)?.[0] ?? headers["message-id"],
    attachments: [],
  };
  walkPart(headers, body, mail);
  return mail;
}
