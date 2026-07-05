import { assert } from "@std/assert";
import { shouldHandle, type TelegramMessage } from "./telegram.ts";

const BOT = "looped_bot";

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
