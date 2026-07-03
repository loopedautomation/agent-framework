import { assert, assertEquals } from "@std/assert";
import { type DiscordMessage, shouldHandle, splitMessage } from "./discord.ts";

const BOT_ID = "bot-1";

function msg(overrides: Partial<DiscordMessage>): DiscordMessage {
  return {
    id: "m1",
    channel_id: "c-issues",
    content: "the export breaks on big files",
    author: { id: "user-1" },
    ...overrides,
  };
}

Deno.test("shouldHandle: ignores bots, itself, and empty messages", () => {
  assert(shouldHandle(msg({}), BOT_ID, "issues", {}));
  assert(!shouldHandle(msg({ author: { id: "x", bot: true } }), BOT_ID, "issues", {}));
  assert(!shouldHandle(msg({ author: { id: BOT_ID } }), BOT_ID, "issues", {}));
  assert(!shouldHandle(msg({ content: "   " }), BOT_ID, "issues", {}));
});

Deno.test("shouldHandle: channel filter matches by name or id", () => {
  const opts = { channels: ["issues"] };
  assert(shouldHandle(msg({}), BOT_ID, "issues", opts));
  assert(!shouldHandle(msg({}), BOT_ID, "general", opts));
  assert(shouldHandle(msg({ channel_id: "issues" }), BOT_ID, undefined, opts));
  // no filter → everything passes
  assert(shouldHandle(msg({}), BOT_ID, "anything", {}));
});

Deno.test("shouldHandle: require_mention", () => {
  const opts = { requireMention: true };
  assert(!shouldHandle(msg({}), BOT_ID, "issues", opts));
  assert(shouldHandle(msg({ mentions: [{ id: BOT_ID }] }), BOT_ID, "issues", opts));
});

Deno.test("shouldHandle: from_users matches by id or username, drops everyone else", () => {
  const opts = { fromUsers: ["user-1", "amin"] };
  assert(shouldHandle(msg({}), BOT_ID, "issues", opts)); // by id
  assert(shouldHandle(msg({ author: { id: "u-9", username: "amin" } }), BOT_ID, "issues", opts));
  assert(
    !shouldHandle(msg({ author: { id: "u-9", username: "someone" } }), BOT_ID, "issues", opts),
  );
  // empty list behaves like no filter
  assert(shouldHandle(msg({ author: { id: "u-9" } }), BOT_ID, "issues", { fromUsers: [] }));
});

Deno.test("splitMessage: respects the 2000-char cap on line boundaries", () => {
  assertEquals(splitMessage("short"), ["short"]);
  const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const parts = splitMessage(long);
  assert(parts.length > 1);
  assert(parts.every((p) => p.length <= 2000));
  assertEquals(parts.join("\n"), long); // nothing lost
});
