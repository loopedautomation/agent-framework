import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type AgentEvent,
  type MediaLimits,
  resolveAttachments,
  type RunResult,
} from "@looped/core";
import {
  pickPhoto,
  shouldHandle,
  stripCommandMention,
  telegramAttachments,
  type TelegramMessage,
  TelegramTrigger,
} from "./telegram.ts";

const BOT = "looped_bot";
const LIMITS: MediaLimits = { maxImageBytes: 1_000, maxImagesPerMessage: 4 };

/** A photo at three resolutions, the way the Bot API sends one: smallest first. */
const PHOTO = [
  { file_id: "s", file_unique_id: "us", width: 90, height: 60, file_size: 100 },
  { file_id: "m", file_unique_id: "um", width: 320, height: 213, file_size: 800 },
  { file_id: "l", file_unique_id: "ul", width: 1280, height: 853, file_size: 40_000 },
];

function msg(overrides: Partial<TelegramMessage>): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: -100123, type: "supergroup", title: "issues" },
    from: { id: 42, username: "amin" },
    text: "the export breaks on big files",
    ...overrides,
  };
}

Deno.test("shouldHandle: ignores bots, missing senders, and empty messages", () => {
  assert(shouldHandle(msg({}), BOT, {}));
  assert(!shouldHandle(msg({ from: { id: 7, is_bot: true } }), BOT, {}));
  assert(!shouldHandle(msg({ from: undefined }), BOT, {}));
  assert(!shouldHandle(msg({ text: "   " }), BOT, {}));
  assert(!shouldHandle(msg({ text: undefined }), BOT, {}));
});

Deno.test("shouldHandle: chat filter matches by id, title, or @username", () => {
  assert(shouldHandle(msg({}), BOT, { chats: ["-100123"] }));
  assert(shouldHandle(msg({}), BOT, { chats: ["issues"] }));
  const publicGroup = msg({ chat: { id: -100123, type: "supergroup", username: "loopedhq" } });
  assert(shouldHandle(publicGroup, BOT, { chats: ["@loopedhq"] }));
  assert(shouldHandle(publicGroup, BOT, { chats: ["loopedhq"] }));
  assert(!shouldHandle(msg({}), BOT, { chats: ["other"] }));
  // no filter → everything passes
  assert(shouldHandle(msg({}), BOT, {}));
});

Deno.test("shouldHandle: require_mention gates groups, never private chats", () => {
  const opts = { requireMention: true };
  assert(!shouldHandle(msg({}), BOT, opts));
  assert(shouldHandle(msg({ text: `@${BOT} status?` }), BOT, opts));
  const dm = msg({ chat: { id: 42, type: "private" } });
  assert(shouldHandle(dm, BOT, opts));
});

Deno.test("shouldHandle: from_users matches by id or username, drops everyone else", () => {
  const opts = { fromUsers: ["42", "petra"] };
  assert(shouldHandle(msg({}), BOT, opts)); // by id
  assert(shouldHandle(msg({ from: { id: 9, username: "petra" } }), BOT, opts));
  assert(!shouldHandle(msg({ from: { id: 9, username: "someone" } }), BOT, opts));
  // empty list behaves like no filter
  assert(shouldHandle(msg({ from: { id: 9 } }), BOT, { fromUsers: [] }));
});

Deno.test("shouldHandle: a caption or an attachment wakes the agent, silence does not", () => {
  const captioned = msg({ text: undefined, caption: "what's wrong here?", photo: PHOTO });
  assert(shouldHandle(captioned, BOT, {}));
  assert(shouldHandle(msg({ text: undefined, photo: PHOTO }), BOT, {})); // no caption at all
  assert(shouldHandle(
    msg({ text: undefined, voice: { file_id: "v", duration: 3, mime_type: "audio/ogg" } }),
    BOT,
    {},
  ));
  assert(!shouldHandle(msg({ text: undefined, caption: "  " }), BOT, {}));
  // A caption mentions the bot the same way text does.
  assert(shouldHandle(
    msg({ text: undefined, caption: `@${BOT} look`, photo: PHOTO }),
    BOT,
    { requireMention: true },
  ));
  assert(!shouldHandle(captioned, BOT, { requireMention: true }));
});

Deno.test("pickPhoto: the largest variant that fits, else the smallest to describe", () => {
  assertEquals(pickPhoto(PHOTO, 1_000)?.file_id, "m");
  assertEquals(pickPhoto(PHOTO, 100_000)?.file_id, "l");
  assertEquals(pickPhoto(PHOTO, 10)?.file_id, "s"); // nothing fits — still named in the prompt
  assertEquals(pickPhoto([], 1_000), undefined);
});

Deno.test("telegramAttachments: a photo resolves to one image, fetched once", async () => {
  const fetched: string[] = [];
  const attachments = telegramAttachments(
    msg({ text: undefined, caption: "look", photo: PHOTO }),
    LIMITS.maxImageBytes,
    (fileId) => {
      fetched.push(fileId);
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
  );
  const { images, notes } = await resolveAttachments(attachments, LIMITS);
  assertEquals(fetched, ["m"]); // the largest under the cap, not the 40 KB original
  assertEquals(notes, []);
  assertEquals(images.length, 1);
  assertEquals(images[0].mediaType, "image/jpeg");
  assertEquals(images[0].data, btoa("\x01\x02\x03"));
});

Deno.test("telegramAttachments: what the agent cannot read survives as a note", async () => {
  const attachments = telegramAttachments(
    msg({
      text: undefined,
      voice: { file_id: "v", duration: 7, mime_type: "audio/ogg", file_size: 2_048 },
      document: {
        file_id: "d",
        file_name: "quarterly.pdf",
        mime_type: "application/pdf",
        file_size: 2_000,
      },
    }),
    LIMITS.maxImageBytes,
    () => Promise.reject(new Error("no bytes should be fetched for these")),
  );
  const { images, notes } = await resolveAttachments(attachments, LIMITS);
  assertEquals(images, []);
  assertEquals(notes.length, 2);
  assert(notes.some((n) => n.includes("audio/ogg")));
  assert(notes.some((n) => n.includes("quarterly.pdf")));
  assert(notes.every((n) => n.includes("not an image")));
});

Deno.test("telegramAttachments: an oversized photo is described, never fetched", async () => {
  const huge = [{
    file_id: "l",
    file_unique_id: "ul",
    width: 4000,
    height: 3000,
    file_size: 9_000,
  }];
  const attachments = telegramAttachments(
    msg({ text: undefined, photo: huge }),
    LIMITS.maxImageBytes,
    () => Promise.reject(new Error("should not fetch past the cap")),
  );
  const { images, notes } = await resolveAttachments(attachments, LIMITS);
  assertEquals(images, []);
  assertEquals(notes.length, 1);
  assert(notes[0].includes("image limit"));
});

Deno.test("stripCommandMention: removes this bot's suffix from a command", () => {
  assertEquals(stripCommandMention("/status@my_bot", "my_bot"), "/status");
  assertEquals(stripCommandMention("/standup@my_bot deploys", "my_bot"), "/standup deploys");
  assertEquals(stripCommandMention("/status@My_Bot", "my_bot"), "/status"); // case-insensitive
});

Deno.test("stripCommandMention: leaves other text alone", () => {
  assertEquals(stripCommandMention("/status@other_bot", "my_bot"), "/status@other_bot");
  assertEquals(stripCommandMention("/status", "my_bot"), "/status");
  assertEquals(stripCommandMention("email me a@b.com", "my_bot"), "email me a@b.com");
});

function okResult(): RunResult {
  return {
    status: "ok",
    reply: "done",
    steps: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    messages: [],
  };
}

/** Wait until the fake API has seen the async reply (dispatched, never awaited). */
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(cond(), "condition never became true");
}

Deno.test("TelegramTrigger: webhook transport registers, verifies and dispatches", async () => {
  // A fake Bot API so the whole trigger runs: getMe, setWebhook, sendMessage.
  // deno-lint-ignore no-explicit-any
  let webhookReg: any;
  // deno-lint-ignore no-explicit-any
  const sent: any[] = [];
  const api = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const pathname = new URL(req.url).pathname;
    const raw = await req.text();
    const body = raw ? JSON.parse(raw) : undefined; // getMe posts no body
    if (pathname.endsWith("/getMe")) {
      return Response.json({ ok: true, result: { username: BOT } });
    }
    if (pathname.endsWith("/setWebhook")) {
      webhookReg = body;
      return Response.json({ ok: true, result: true });
    }
    if (pathname.endsWith("/sendMessage")) {
      sent.push(body);
      return Response.json({ ok: true, result: {} });
    }
    return Response.json({ ok: false, description: `unexpected ${pathname}` }, { status: 404 });
  });

  let port = 0;
  const trigger = new TelegramTrigger({
    token: "TOKEN",
    transport: "webhook",
    port: 0,
    path: "/telegram",
    publicUrl: "https://agent.example/",
    apiBase: `http://127.0.0.1:${api.addr.port}`,
    onListen: (addr) => (port = addr.port),
  });
  const seen: AgentEvent[] = [];
  await trigger.start((event) => {
    seen.push(event);
    return Promise.resolve(okResult());
  });

  // Registration went out with the joined URL and a minted secret.
  assertEquals(webhookReg.url, "https://agent.example/telegram");
  const secret: string = webhookReg.secret_token;
  assert(secret.length > 0);

  const post = async (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<number> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    await res.body?.cancel();
    return res.status;
  };

  const update = { update_id: 7, message: msg({}) };

  // No secret header, a wrong secret, a wrong path: never Telegram, never a run.
  assertEquals(await post("/telegram", update), 401);
  assertEquals(
    await post("/telegram", update, { "x-telegram-bot-api-secret-token": "guess" }),
    401,
  );
  assertEquals(await post("/other", update), 404);

  // A real delivery is acked and wakes the agent; the reply goes out after.
  assertEquals(
    await post("/telegram", update, { "x-telegram-bot-api-secret-token": secret }),
    200,
  );
  await until(() => sent.length === 1);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].id, "7");
  assertEquals(seen[0].conversationKey, "telegram:-100123");
  assertStringIncludes(seen[0].input, "the export breaks on big files");
  assertEquals(sent[0].text, "done");

  await trigger.stop();
  await api.shutdown();
});
