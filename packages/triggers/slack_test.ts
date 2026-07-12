import { assert, assertEquals } from "@std/assert";
import { shouldHandle, slackAttachments, type SlackMessage } from "./slack.ts";
import { resolveAttachments } from "@looped/core";

const BOT_ID = "U0BOT";
const TOKEN = "xoxb-test";
const LIMITS = { maxImageBytes: 1_000, maxImagesPerMessage: 2 };

function png(name: string) {
  return {
    id: "F1",
    name,
    mimetype: "image/png",
    filetype: "png",
    size: 300,
    url_private: `https://files.slack.com/files-pri/T1-F1/${name}`,
  };
}

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

Deno.test("shouldHandle: a file_share upload is not a subtype to drop", () => {
  const upload = msg({ subtype: "file_share", text: "", files: [png("shot.png")] });
  assert(shouldHandle(upload, BOT_ID, "issues", {}));
  // every other subtype is still a join/leave/edit and stays dropped
  assert(
    !shouldHandle(msg({ subtype: "message_changed", files: [png("x.png")] }), BOT_ID, "i", {}),
  );
  // the filters still apply to an upload
  assert(!shouldHandle(upload, BOT_ID, "general", { channels: ["issues"] }));
  // an upload with no caption passes the mention gate only in a DM
  assert(!shouldHandle(upload, BOT_ID, "issues", { requireMention: true }));
});

Deno.test("slackAttachments: an upload resolves to an image, fetched with the bot token", async () => {
  let auth: string | null = null;
  const files = ((_url: RequestInfo | URL, init?: RequestInit) => {
    auth = new Headers(init?.headers).get("authorization");
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
  }) as typeof fetch;

  const upload = msg({ subtype: "file_share", text: "", files: [png("shot.png")] });
  const media = await resolveAttachments(slackAttachments(upload, TOKEN, files), LIMITS);
  assertEquals(auth, `Bearer ${TOKEN}`);
  assertEquals(media.notes, []);
  assertEquals(media.images.length, 1);
  assertEquals(media.images[0].mediaType, "image/png");
});

Deno.test("slackAttachments: a missing files:read scope is a note, not a corrupt image", async () => {
  // Slack answers 200 with its sign-in page when the scope is absent. Status
  // alone would let an HTML document through wearing an image's media type.
  const login = (() =>
    Promise.resolve(
      new Response("<html>sign in to slack</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    )) as typeof fetch;

  const upload = msg({ subtype: "file_share", text: "", files: [png("shot.png")] });
  const media = await resolveAttachments(slackAttachments(upload, TOKEN, login), LIMITS);
  assertEquals(media.images, []);
  assertEquals(media.notes.length, 1);
  assert(media.notes[0].includes("files:read"));
});

Deno.test("slackAttachments: a non-image upload is described, never read", async () => {
  const files = (() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch;
  const upload = msg({
    subtype: "file_share",
    text: "",
    files: [{ id: "F2", name: "q3.pdf", mimetype: "application/pdf", size: 2_000 }],
  });
  const media = await resolveAttachments(slackAttachments(upload, TOKEN, files), LIMITS);
  assertEquals(media.images, []);
  assertEquals(media.notes.length, 1);
  assert(media.notes[0].includes("q3.pdf"));
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
