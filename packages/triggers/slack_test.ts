import { assert } from "@std/assert";
import { shouldHandle, type SlackMessage } from "./slack.ts";

const BOT_ID = "U0BOT";

function msg(overrides: Partial<SlackMessage>): SlackMessage {
  return {
    type: "message",
    user: "U0USER",
    text: "the export breaks on big files",
    channel: "C0ISSUES",
    channel_type: "channel",
    ts: "1751.0001",
    ...overrides,
  };
}

Deno.test("shouldHandle: ignores bots, itself, subtypes, and empty messages", () => {
  assert(shouldHandle(msg({}), BOT_ID, "issues", {}));
  assert(!shouldHandle(msg({ bot_id: "B01" }), BOT_ID, "issues", {}));
  assert(!shouldHandle(msg({ user: BOT_ID }), BOT_ID, "issues", {}));
  assert(!shouldHandle(msg({ user: undefined }), BOT_ID, "issues", {}));
  // edits, joins, bot posts, … arrive as subtypes of "message"
  assert(!shouldHandle(msg({ subtype: "message_changed" }), BOT_ID, "issues", {}));
  assert(!shouldHandle(msg({ type: "app_mention" }), BOT_ID, "issues", {}));
  assert(!shouldHandle(msg({ text: "   " }), BOT_ID, "issues", {}));
});

Deno.test("shouldHandle: channel filter matches by name or id", () => {
  const opts = { channels: ["issues"] };
  assert(shouldHandle(msg({}), BOT_ID, "issues", opts));
  assert(!shouldHandle(msg({}), BOT_ID, "general", opts));
  assert(shouldHandle(msg({ channel: "issues" }), BOT_ID, undefined, opts));
  // no filter → everything passes
  assert(shouldHandle(msg({}), BOT_ID, "anything", {}));
});

Deno.test("shouldHandle: require_mention gates channels, never DMs", () => {
  const opts = { requireMention: true };
  assert(!shouldHandle(msg({}), BOT_ID, "issues", opts));
  assert(shouldHandle(msg({ text: `<@${BOT_ID}> status?` }), BOT_ID, "issues", opts));
  const dm = msg({ channel: "D0DM", channel_type: "im" });
  assert(shouldHandle(dm, BOT_ID, undefined, opts));
});

Deno.test("shouldHandle: from_users matches by user id, drops everyone else", () => {
  const opts = { fromUsers: ["U0USER"] };
  assert(shouldHandle(msg({}), BOT_ID, "issues", opts));
  assert(!shouldHandle(msg({ user: "U0OTHER" }), BOT_ID, "issues", opts));
  // empty list behaves like no filter
  assert(shouldHandle(msg({ user: "U0OTHER" }), BOT_ID, "issues", { fromUsers: [] }));
});
