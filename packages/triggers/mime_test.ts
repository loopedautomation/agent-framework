import { assert, assertEquals } from "@std/assert";
import { decodeWords, parseMime } from "./mime.ts";

Deno.test("parseMime: plain message, folded headers, quoted-printable body", () => {
  const raw = [
    "From: Petra Lang <petra@example.com>",
    "To: agent@example.com",
    "Subject: Invoice",
    " 42", // folded continuation
    "Message-Id: <orig@example.com>",
    "Date: Tue, 07 Jul 2026 09:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Caf=C3=A9 receipt attached below the fold =",
    "and this continues the line.",
  ].join("\r\n");
  const mail = parseMime(raw);
  assertEquals(mail.from, "Petra Lang <petra@example.com>");
  assertEquals(mail.subject, "Invoice 42");
  assertEquals(mail.messageId, "<orig@example.com>");
  assertEquals(
    mail.text,
    "Café receipt attached below the fold and this continues the line.",
  );
});

Deno.test("parseMime: multipart/alternative prefers plain, lists attachments", () => {
  const b64 = btoa("<p>Hello <b>there</b></p>");
  const raw = [
    "From: petra@example.com",
    "Subject: mixed",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "preamble to be ignored",
    "--outer",
    'Content-Type: multipart/alternative; boundary="inner"',
    "",
    "--inner",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "Hello there",
    "--inner",
    "Content-Type: text/html; charset=us-ascii",
    "Content-Transfer-Encoding: base64",
    "",
    b64,
    "--inner--",
    "--outer",
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa("%PDF-fake"),
    "--outer--",
    "",
  ].join("\r\n");
  const mail = parseMime(raw);
  assertEquals(mail.text, "Hello there");
  assert(mail.html!.includes("<b>there</b>"));
  assertEquals(mail.attachments.length, 1);
  assertEquals(mail.attachments[0].filename, "invoice.pdf");
  assertEquals(mail.attachments[0].contentType, "application/pdf");
  // The bytes come out decoded, and the size is what the file weighs — not the
  // longer base64 the wire carried.
  assertEquals(new TextDecoder().decode(mail.attachments[0].bytes), "%PDF-fake");
  assertEquals(mail.attachments[0].size, 9);
});

Deno.test("parseMime: an inline image keeps its bytes", () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const raw = [
    "From: petra@example.com",
    "Subject: screenshot",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "See attached.",
    "--b",
    'Content-Type: image/png; name="shot.png"',
    'Content-Disposition: attachment; filename="shot.png"',
    "Content-Transfer-Encoding: base64",
    "",
    png,
    "--b--",
    "",
  ].join("\r\n");
  const [attachment] = parseMime(raw).attachments;
  assertEquals(attachment.contentType, "image/png");
  assertEquals(attachment.size, 70);
  assertEquals(btoa(String.fromCharCode(...attachment.bytes)), png);
});

Deno.test("parseMime: base64 body with non-utf8 charset falls back cleanly", () => {
  const raw = [
    "From: petra@example.com",
    "Content-Type: text/plain; charset=iso-8859-1",
    "Content-Transfer-Encoding: base64",
    "",
    btoa("caf\xe9"), // latin1 é
  ].join("\r\n");
  assertEquals(parseMime(raw).text, "café");
});

Deno.test("decodeWords: RFC 2047 B and Q encodings, adjacent words join", () => {
  assertEquals(decodeWords("=?utf-8?Q?Caf=C3=A9_time?="), "Café time");
  assertEquals(decodeWords("=?utf-8?B?Q2Fmw6k=?="), "Café");
  assertEquals(decodeWords("=?utf-8?B?Q2Fm?= =?utf-8?B?w6k=?="), "Café");
  assertEquals(decodeWords("plain subject"), "plain subject");
});
