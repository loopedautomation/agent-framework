import { assert, assertEquals } from "@std/assert";
import type { AgentEvent, RunResult } from "@looped/core";
import { OutlookEmailTrigger } from "./email_outlook.ts";

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

const MEDIA = { maxImageBytes: 5_000_000, maxImagesPerMessage: 4 };

/** A 1x1 PNG, base64. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function fakeGraph() {
  const state = {
    tokenBodies: [] as string[],
    unread: true,
    replies: [] as { id: string; comment: string }[],
    patched: [] as string[],
    listPaths: [] as string[],
    attachmentsFetched: [] as string[],
  };
  const message = {
    id: "m1",
    conversationId: "c1",
    subject: "Invoice 42",
    from: { emailAddress: { name: "Petra Lang", address: "petra@example.com" } },
    toRecipients: [{ emailAddress: { address: "assistant@example.com" } }],
    replyTo: [],
    receivedDateTime: "2026-07-07T09:00:00Z",
    body: { contentType: "text", content: "Please file the attached invoice." },
    internetMessageHeaders: [{ name: "Message-ID", value: "<orig@example.com>" }],
    attachments: [
      { id: "a_pdf", name: "invoice.pdf", contentType: "application/pdf", size: 1234 },
      { id: "a_png", name: "shot.png", contentType: "image/png", size: 70 },
    ],
  };
  let port = 0;
  const server = Deno.serve({ port: 0, onListen: (a) => (port = a.port) }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/token") {
      state.tokenBodies.push(await req.text());
      return Response.json({ access_token: "at1", expires_in: 3600, refresh_token: "rt2" });
    }
    if (url.pathname === "/me") return Response.json({ mail: "Assistant@Example.com" });
    if (url.pathname === "/me/mailFolders/inbox/messages") {
      state.listPaths.push(url.search);
      return Response.json({ value: state.unread ? [message] : [] });
    }
    const att = url.pathname.match(/^\/me\/messages\/m1\/attachments\/(\w+)\/\$value$/);
    if (att) {
      state.attachmentsFetched.push(att[1]);
      return new Response(Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0)));
    }
    if (req.method === "POST" && url.pathname === "/me/messages/m1/reply") {
      state.replies.push({ id: "m1", comment: (await req.json()).comment });
      return new Response(null, { status: 202 });
    }
    if (req.method === "PATCH" && url.pathname === "/me/messages/m1") {
      await req.json();
      state.patched.push("m1");
      state.unread = false;
      return Response.json({});
    }
    return Response.json({ error: url.pathname }, { status: 500 });
  });
  return { state, apiBase: () => `http://127.0.0.1:${port}`, close: () => server.shutdown() };
}

Deno.test("outlook: unread mail wakes the agent, reply goes to the conversation, cursor advances", async () => {
  const api = fakeGraph();
  const events: AgentEvent[] = [];
  const trigger = new OutlookEmailTrigger({
    clientId: "cid",
    refreshToken: "rt1",
    tenant: "consumers",
    folder: "inbox",
    pollSeconds: 60, // the first poll is immediate; the test never waits an interval
    fromAddresses: ["petra@example.com"],
    media: MEDIA,
    apiBase: api.apiBase(),
    tokenUrl: `${api.apiBase()}/token`,
  });
  await trigger.start((event) => {
    events.push(event);
    return Promise.resolve(runResult("Filed it."));
  });

  await until(() => api.state.replies.length === 1 && api.state.patched.length === 1);
  await trigger.stop();
  await new Promise((r) => setTimeout(r, 50));
  await api.close();

  // A public client refreshes without a secret.
  assert(api.state.tokenBodies[0].includes("client_id=cid"));
  assert(!api.state.tokenBodies[0].includes("client_secret"));

  assertEquals(events.length, 1);
  assert(events[0].input.includes("From: Petra Lang <petra@example.com>"));
  assert(events[0].input.includes("Please file the attached invoice."));
  assert(events[0].input.includes("invoice.pdf"));
  assertEquals(events[0].conversationKey, "email:outlook:c1");

  // The list stays cheap: ids, not contentBytes. Only the image is fetched.
  assert(api.state.listPaths[0].includes("attachments(%24select%3Did%2Cname"));
  assert(!api.state.listPaths[0].includes("contentBytes"));
  assertEquals(api.state.attachmentsFetched, ["a_png"]);
  assertEquals(events[0].images?.length, 1);
  assertEquals(events[0].images?.[0].data, PNG_BASE64);
  assert(!events[0].input.includes("shot.png"));
  assertEquals(api.state.replies[0].comment, "Filed it.");
  assertEquals(api.state.patched, ["m1"]);
});
