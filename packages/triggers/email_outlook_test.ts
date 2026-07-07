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

function fakeGraph() {
  const state = {
    tokenBodies: [] as string[],
    unread: true,
    replies: [] as { id: string; comment: string }[],
    patched: [] as string[],
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
    attachments: [{ name: "invoice.pdf", contentType: "application/pdf", size: 1234 }],
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
      return Response.json({ value: state.unread ? [message] : [] });
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
  assertEquals(api.state.replies[0].comment, "Filed it.");
  assertEquals(api.state.patched, ["m1"]);
});
