import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type DiscordMessage,
  fetchApplicationId,
  INVITE_PERMISSIONS,
  inviteUrl,
  NO_REPLY,
  shouldHandle,
  splitMessage,
  typingLoop,
} from "./discord.ts";
import { isSilence } from "./text.ts";

const BOT_ID = "bot-1";

function msg(overrides: Partial<DiscordMessage>): DiscordMessage {
  return {
    id: "m1",
    channel_id: "c-issues",
    guild_id: "g1",
    content: "the export breaks on big files",
    author: { id: "user-1" },
    ...overrides,
  };
}

Deno.test("shouldHandle: ignores bots, itself, and empty messages", () => {
  assert(shouldHandle(msg({}), BOT_ID, { name: "issues" }, {}));
  assert(!shouldHandle(msg({ author: { id: "x", bot: true } }), BOT_ID, { name: "issues" }, {}));
  assert(!shouldHandle(msg({ author: { id: BOT_ID } }), BOT_ID, { name: "issues" }, {}));
  assert(!shouldHandle(msg({ content: "   " }), BOT_ID, { name: "issues" }, {}));
});

Deno.test("shouldHandle: channel filter matches by name or id", () => {
  const opts = { channels: ["issues"] };
  assert(shouldHandle(msg({}), BOT_ID, { name: "issues" }, opts));
  assert(!shouldHandle(msg({}), BOT_ID, { name: "general" }, opts));
  assert(shouldHandle(msg({ channel_id: "issues" }), BOT_ID, undefined, opts));
  // no filter → everything passes
  assert(shouldHandle(msg({}), BOT_ID, { name: "anything" }, {}));
});

Deno.test("shouldHandle: channel filter matches a thread via its parent channel", () => {
  // A thread message carries the thread's id and title, not the parent's —
  // the parent info is what lets `channels: ["issues"]` keep matching inside.
  const thread = { name: "big-file export", parentId: "c-issues", parentName: "issues" };
  assert(shouldHandle(msg({ channel_id: "t-1" }), BOT_ID, thread, { channels: ["issues"] }));
  assert(shouldHandle(msg({ channel_id: "t-1" }), BOT_ID, thread, { channels: ["c-issues"] }));
  assert(!shouldHandle(msg({ channel_id: "t-1" }), BOT_ID, thread, { channels: ["general"] }));
});

Deno.test("shouldHandle: require_mention", () => {
  const opts = { requireMention: true };
  assert(!shouldHandle(msg({}), BOT_ID, { name: "issues" }, opts));
  assert(shouldHandle(msg({ mentions: [{ id: BOT_ID }] }), BOT_ID, { name: "issues" }, opts));
});

Deno.test("shouldHandle: DMs skip the channel filter and the mention gate", () => {
  const dm = msg({ guild_id: undefined, channel_id: "dm-1" });
  assert(shouldHandle(dm, BOT_ID, undefined, { channels: ["issues"], requireMention: true }));
  // from_users still applies in DMs
  assert(!shouldHandle(dm, BOT_ID, undefined, { fromUsers: ["someone-else"] }));
  // and the bot's own DMs are still ignored
  assert(
    !shouldHandle(msg({ guild_id: undefined, author: { id: BOT_ID } }), BOT_ID, undefined, {}),
  );
});

Deno.test("shouldHandle: from_users matches by id or username, drops everyone else", () => {
  const opts = { fromUsers: ["user-1", "amin"] };
  const issues = { name: "issues" };
  assert(shouldHandle(msg({}), BOT_ID, issues, opts)); // by id
  assert(shouldHandle(msg({ author: { id: "u-9", username: "amin" } }), BOT_ID, issues, opts));
  assert(
    !shouldHandle(msg({ author: { id: "u-9", username: "someone" } }), BOT_ID, issues, opts),
  );
  // empty list behaves like no filter
  assert(shouldHandle(msg({ author: { id: "u-9" } }), BOT_ID, issues, { fromUsers: [] }));
});

Deno.test("splitMessage: respects the 2000-char cap on line boundaries", () => {
  assertEquals(splitMessage("short"), ["short"]);
  const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const parts = splitMessage(long);
  assert(parts.length > 1);
  assert(parts.every((p) => p.length <= 2000));
  assertEquals(parts.join("\n"), long); // nothing lost
});

Deno.test("inviteUrl: correct client_id, scope, and permissions integer", () => {
  assertEquals(INVITE_PERMISSIONS, 68608); // VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY
  assertEquals(
    inviteUrl("1234567890"),
    "https://discord.com/oauth2/authorize?client_id=1234567890&scope=bot&permissions=68608",
  );
});

Deno.test("typingLoop: fires immediately, keeps firing, and stops cleanly", async () => {
  let fired = 0;
  const stop = typingLoop(() => fired++, 5);
  assertEquals(fired, 1); // immediate first fire
  await new Promise((r) => setTimeout(r, 20));
  assert(fired > 1); // kept alive on the interval
  stop();
  const atStop = fired;
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(fired, atStop); // nothing after stop
});

Deno.test("fetchApplicationId: returns id, throws readable error on bad token", async () => {
  const ok =
    ((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ id: "app-42" })))) as typeof fetch;
  assertEquals(await fetchApplicationId("token", ok), "app-42");

  const unauthorized =
    ((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 401 }))) as typeof fetch;
  await assertRejects(() => fetchApplicationId("bad", unauthorized), Error, "check the bot token");
});

Deno.test("isSilence: tolerates punctuation and whitespace around the sentinel", () => {
  assert(isSilence(""));
  assert(isSilence(NO_REPLY));
  assert(isSilence(`${NO_REPLY}.`));
  assert(isSilence(`"${NO_REPLY}".`));
  assert(isSilence(`  ${NO_REPLY} \n`));
  // the sentinel embedded in real content still posts
  assert(!isSilence(`${NO_REPLY} but here is my actual answer`));
  assert(!isSilence(`I would reply ${NO_REPLY} to this`));
  assert(!isSilence("a normal reply."));
});
