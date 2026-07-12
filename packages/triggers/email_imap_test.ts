import { assert, assertEquals } from "@std/assert";
import type { AgentEvent, RunResult } from "@looped/core";
import { ImapEmailTrigger } from "./email_imap.ts";

// The trigger end to end against fake IMAP and SMTP servers on plain TCP:
// unseen messages wake the agent, replies go out over SMTP with threading
// headers, and every inspected message ends up flagged \Seen (the cursor).

function runResult(reply: string): RunResult {
  return {
    status: "ok",
    reply,
    steps: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    messages: [],
  };
}

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function lineServer(
  handler: (line: string, io: { write: (s: string) => Promise<void>; close: () => void }) =>
    | Promise<"data-mode" | void>
    | "data-mode"
    | void,
  onConnect?: (write: (s: string) => Promise<void>) => Promise<void>,
) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const dataLines: string[][] = [];
  (async () => {
    for await (const conn of listener) {
      (async () => {
        const enc = new TextEncoder();
        const dec = new TextDecoder("latin1");
        const write = async (s: string) => {
          await conn.write(enc.encode(s));
        };
        const io = {
          write,
          close: () => {
            try {
              conn.close();
            } catch { /* already closed */ }
          },
        };
        try {
          await onConnect?.(write);
          let buf = "";
          let data: string[] | null = null;
          const chunk = new Uint8Array(8192);
          for (;;) {
            const n = await conn.read(chunk);
            if (n === null) break;
            buf += dec.decode(chunk.subarray(0, n));
            let idx: number;
            while ((idx = buf.indexOf("\r\n")) !== -1) {
              const line = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              if (data !== null) {
                if (line === ".") {
                  dataLines.push(data);
                  data = null;
                  await write("250 stored\r\n");
                } else {
                  data.push(line);
                }
                continue;
              }
              if ((await handler(line, io)) === "data-mode") data = [];
            }
          }
        } catch {
          /* connection torn down mid-command */
        } finally {
          io.close();
        }
      })();
    }
  })().catch(() => {});
  return {
    port,
    dataLines,
    close: () => {
      try {
        listener.close();
      } catch { /* already closed */ }
    },
  };
}

function fakeImap(messages: { uid: number; raw: string }[]) {
  const unseen = new Set(messages.map((m) => m.uid));
  const seen: number[] = [];
  const server = lineServer(
    async (line, io) => {
      const [tag, ...rest] = line.split(" ");
      const cmd = rest.join(" ").toUpperCase();
      if (cmd.startsWith("UID SEARCH")) {
        const ids = [...unseen].join(" ");
        await io.write(`* SEARCH${ids ? " " + ids : ""}\r\n${tag} OK SEARCH done\r\n`);
      } else if (cmd.startsWith("UID FETCH")) {
        const uid = Number(rest[2]);
        const msg = messages.find((m) => m.uid === uid);
        if (msg) {
          await io.write(
            `* 1 FETCH (UID ${uid} BODY[] {${msg.raw.length}}\r\n${msg.raw})\r\n`,
          );
        }
        await io.write(`${tag} OK FETCH done\r\n`);
      } else if (cmd.startsWith("UID STORE")) {
        const uid = Number(rest[2]);
        seen.push(uid);
        unseen.delete(uid);
        await io.write(`${tag} OK STORE done\r\n`);
      } else if (cmd.startsWith("SELECT")) {
        await io.write(`* 1 EXISTS\r\n${tag} OK [READ-WRITE] SELECT done\r\n`);
      } else if (cmd.startsWith("LOGOUT")) {
        await io.write(`* BYE\r\n${tag} OK LOGOUT done\r\n`);
        io.close();
      } else {
        await io.write(`${tag} OK done\r\n`); // LOGIN and anything else
      }
    },
    (write) => write("* OK fake imap ready\r\n"),
  );
  return { ...server, seen };
}

function fakeSmtp() {
  return lineServer(
    async (line, io) => {
      const cmd = line.split(" ")[0].toUpperCase();
      if (cmd === "DATA") {
        await io.write("354 go ahead\r\n");
        return "data-mode";
      }
      if (cmd === "AUTH") await io.write("235 authed\r\n");
      else if (cmd === "QUIT") {
        await io.write("221 bye\r\n");
        io.close();
      } else await io.write("250 ok\r\n"); // EHLO, MAIL, RCPT
    },
    (write) => write("220 fake smtp ready\r\n"),
  );
}

const MEDIA = { maxImageBytes: 5_000_000, maxImagesPerMessage: 4 };

/** A 1x1 PNG, base64. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const RAW_ALLOWED = [
  "From: Petra Lang <petra@example.com>",
  "To: agent@example.com",
  "Subject: Invoice 42",
  "Message-Id: <orig@example.com>",
  "Date: Tue, 07 Jul 2026 09:00:00 +0000",
  'Content-Type: multipart/mixed; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Please file the attached invoice.",
  "--b",
  'Content-Type: image/png; name="shot.png"',
  'Content-Disposition: attachment; filename="shot.png"',
  "Content-Transfer-Encoding: base64",
  "",
  PNG_BASE64,
  "--b",
  'Content-Type: application/pdf; name="invoice.pdf"',
  'Content-Disposition: attachment; filename="invoice.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  btoa("%PDF-fake"),
  "--b--",
  "",
].join("\r\n");

const RAW_STRANGER = [
  "From: stranger@elsewhere.net",
  "To: agent@example.com",
  "Subject: buy now",
  "",
  "spam spam spam",
].join("\r\n");

Deno.test("imap: unseen mail wakes the agent, reply threads over SMTP, cursor advances", async () => {
  const imap = fakeImap([{ uid: 7, raw: RAW_ALLOWED }, { uid: 9, raw: RAW_STRANGER }]);
  const smtp = fakeSmtp();
  const events: AgentEvent[] = [];
  const trigger = new ImapEmailTrigger({
    host: "127.0.0.1",
    port: imap.port,
    username: "agent@example.com",
    password: "pw",
    smtpHost: "127.0.0.1",
    smtpPort: smtp.port,
    folder: "INBOX",
    pollSeconds: 60, // the first poll is immediate; the test never waits an interval
    fromAddresses: ["*@example.com"],
    media: MEDIA,
    tls: false,
    smtpTls: false,
  });
  await trigger.start((event) => {
    events.push(event);
    return Promise.resolve(runResult("Filed it."));
  });

  await until(() => smtp.dataLines.length === 1 && imap.seen.length === 2);
  await trigger.stop();
  await new Promise((r) => setTimeout(r, 50)); // let the poll loop wind down
  imap.close();
  smtp.close();

  // Only the allowlisted sender reached the model; both messages are the cursor.
  assertEquals(events.length, 1);
  assert(events[0].input.includes("Subject: Invoice 42"));
  assert(events[0].input.includes("Please file the attached invoice."));
  assertEquals(events[0].conversationKey, "email:<orig@example.com>");
  assertEquals(imap.seen.toSorted(), [7, 9]);

  // The MIME already held the bytes: the PNG is an image, the PDF is prose.
  assertEquals(events[0].images?.length, 1);
  assertEquals(events[0].images?.[0].mediaType, "image/png");
  assertEquals(events[0].images?.[0].data, PNG_BASE64);
  assert(events[0].input.includes("[attachment: invoice.pdf (application/pdf, 9 bytes)"));
  assert(!events[0].input.includes("shot.png"));

  const sent = smtp.dataLines[0].join("\n");
  assert(sent.includes("Subject: Re: Invoice 42"));
  assert(sent.includes("In-Reply-To: <orig@example.com>"));
  assert(sent.includes("To: Petra Lang <petra@example.com>"));
  assert(sent.includes("Filed it."));
});

Deno.test("imap: a bad login fails start, ahead of the first message", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  (async () => {
    for await (const conn of listener) {
      const enc = new TextEncoder();
      await conn.write(enc.encode("* OK ready\r\n"));
      const buf = new Uint8Array(1024);
      await conn.read(buf); // the LOGIN attempt
      await conn.write(enc.encode("A1 NO [AUTHENTICATIONFAILED] nope\r\n"));
      try {
        conn.close();
      } catch { /* closed */ }
    }
  })().catch(() => {});

  const trigger = new ImapEmailTrigger({
    host: "127.0.0.1",
    port,
    username: "agent@example.com",
    password: "wrong",
    smtpHost: "127.0.0.1",
    smtpPort: 1,
    folder: "INBOX",
    pollSeconds: 60,
    fromAddresses: ["*"],
    media: MEDIA,
    tls: false,
    smtpTls: false,
  });
  let failed = false;
  try {
    await trigger.start(() => Promise.resolve(runResult("")));
  } catch (err) {
    failed = true;
    assert((err as Error).message.includes("LOGIN failed"));
  }
  assert(failed);
  await trigger.stop();
  listener.close();
});
