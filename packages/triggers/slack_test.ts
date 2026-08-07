import { assert, assertEquals } from "@std/assert";
import {
  shouldHandle,
  slackAttachments,
  type SlackMessage,
  SlackTrigger,
  verifySlackSignature,
} from "./slack.ts";
import { type AgentEvent, resolveAttachments, type RunResult } from "@looped/core";

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

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

// The signing inputs from Slack's docs (Verifying requests from Slack);
// the expected signature is computed from them with an independent HMAC.
const VECTOR_TS = "1531420618";
const VECTOR_BODY =
  "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
const VECTOR_SIG = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";

async function sign(timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  return "v0=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("verifySlackSignature: accepts Slack's documented vector", async () => {
  assert(
    await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      timestamp: VECTOR_TS,
      body: VECTOR_BODY,
      signature: VECTOR_SIG,
      now: () => Number(VECTOR_TS),
    }),
  );
});

Deno.test("verifySlackSignature: rejects a wrong signature, wrong secret, and a replay", async () => {
  const now = () => Number(VECTOR_TS);
  assert(
    !(await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      timestamp: VECTOR_TS,
      body: VECTOR_BODY + "x",
      signature: VECTOR_SIG,
      now,
    })),
  );
  assert(
    !(await verifySlackSignature({
      signingSecret: "some other secret",
      timestamp: VECTOR_TS,
      body: VECTOR_BODY,
      signature: VECTOR_SIG,
      now,
    })),
  );
  // A valid signature from an hour ago is a replay, not a slow network.
  assert(
    !(await verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      timestamp: VECTOR_TS,
      body: VECTOR_BODY,
      signature: VECTOR_SIG,
      now: () => Number(VECTOR_TS) + 3600,
    })),
  );
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

/** Wait until the async dispatch (never awaited by the server) has landed. */
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(cond(), "condition never became true");
}

Deno.test("SlackTrigger: events_api transport verifies, acks, dedupes and dispatches", async () => {
  // A fake Web API so the whole trigger runs: auth.test, chat.postMessage,
  // plus a /response sink for slash-command response_url replies.
  // deno-lint-ignore no-explicit-any
  const posted: any[] = [];
  // deno-lint-ignore no-explicit-any
  const responded: any[] = [];
  const api = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const pathname = new URL(req.url).pathname;
    if (pathname.endsWith("/auth.test")) {
      return Response.json({ ok: true, user_id: BOT_ID, user: "looped" });
    }
    if (pathname.endsWith("/chat.postMessage")) {
      posted.push(await req.json());
      return Response.json({ ok: true });
    }
    if (pathname === "/response") {
      responded.push(await req.json());
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false, error: `unexpected ${pathname}` }, { status: 404 });
  });

  let port = 0;
  const trigger = new SlackTrigger({
    token: TOKEN,
    transport: "events_api",
    port: 0,
    path: "/slack",
    signingSecret: SIGNING_SECRET,
    apiBase: `http://127.0.0.1:${api.addr.port}`,
    onListen: (addr) => (port = addr.port),
  });
  const seen: AgentEvent[] = [];
  await trigger.start((event) => {
    seen.push(event);
    return Promise.resolve(okResult());
  });

  const post = async (
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; json?: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${port}/slack`, {
      method: "POST",
      headers,
      body,
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return { status: res.status };
    }
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const signedHeaders = async (body: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": await sign(ts, body),
    };
  };

  // Unsigned delivery: 401, no run.
  const unsigned = await post("{}", { "content-type": "application/json" });
  assertEquals(unsigned.status, 401);

  // The app-config handshake answers without a run.
  const challengeBody = JSON.stringify({ type: "url_verification", challenge: "c0ffee" });
  const challenge = await post(challengeBody, await signedHeaders(challengeBody));
  assertEquals(challenge.json?.challenge, "c0ffee");

  // A signed message event is acked and wakes the agent; the reply threads after.
  const eventBody = JSON.stringify({
    type: "event_callback",
    event_id: "Ev1",
    event: msg({}),
  });
  const first = await post(eventBody, await signedHeaders(eventBody));
  assertEquals(first.status, 200);
  await until(() => posted.length === 1);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].conversationKey, "slack:C0ISSUES:1751.0001");
  assertEquals(posted[0].text, "done");

  // Slack retried the same delivery (a cold boot ate the first ack): deduped, no second run.
  const retry = await post(eventBody, await signedHeaders(eventBody));
  assertEquals(retry.json?.deduplicated, true);
  assertEquals(seen.length, 1);

  // A slash command arrives form-encoded and replies through its response_url.
  const form = new URLSearchParams({
    command: "/status",
    text: "deploys",
    user_id: "U0USER",
    channel_id: "C0ISSUES",
    response_url: `http://127.0.0.1:${api.addr.port}/response`,
  }).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  const cmd = await post(form, {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": ts,
    "x-slack-signature": await sign(ts, form),
  });
  assertEquals(cmd.status, 200);
  await until(() => responded.length === 1);
  assertEquals(seen.length, 2);
  assertEquals(seen[1].input, "/status deploys");
  assertEquals(responded[0].text, "done");

  // Far past anything Slack sends — a message tops out at 40k characters. The
  // signature header is deliberately wrong: 413 rather than 401 is the proof
  // that the read gave up before the body was verified, which is the only
  // ordering that bounds what an unauthenticated POST can put in memory.
  const oversized = await fetch(`http://127.0.0.1:${port}/slack`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": "v0=" + "0".repeat(64),
    },
    body: new Uint8Array(2 * 1024 * 1024),
  });
  assertEquals(oversized.status, 413);
  await oversized.body?.cancel();
  assertEquals(seen.length, 2);

  await trigger.stop();
  await api.shutdown();
});
