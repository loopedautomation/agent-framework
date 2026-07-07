import { assert, assertEquals } from "@std/assert";
import type { AgentEvent, RunResult } from "@looped/core";
import { GmailEmailTrigger } from "./email_gmail.ts";

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

function base64Url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeGmail() {
  const state = {
    tokenRequests: 0,
    unread: new Set(["m1", "m2"]),
    modified: [] as string[],
    sent: [] as { raw: string; threadId: string }[],
    authSeen: new Set<string>(),
  };
  const payloads: Record<string, unknown> = {
    m1: {
      threadId: "t1",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: "Petra Lang <petra@example.com>" },
          { name: "To", value: "assistant@example.com" },
          { name: "Subject", value: "Invoice 42" },
          { name: "Message-ID", value: "<orig@example.com>" },
          { name: "Date", value: "Tue, 07 Jul 2026 09:00:00 +0000" },
        ],
        parts: [
          {
            mimeType: "text/plain",
            body: { data: base64Url("Please file the attached invoice.") },
          },
          { mimeType: "application/pdf", filename: "invoice.pdf", body: { size: 1234 } },
        ],
      },
    },
    m2: {
      threadId: "t2",
      payload: {
        headers: [{ name: "From", value: "stranger@elsewhere.net" }],
        mimeType: "text/plain",
        body: { data: base64Url("buy now") },
      },
    },
  };
  let port = 0;
  const server = Deno.serve({ port: 0, onListen: (a) => (port = a.port) }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/token") {
      state.tokenRequests++;
      return Response.json({ access_token: "at1", expires_in: 3600 });
    }
    state.authSeen.add(req.headers.get("authorization") ?? "");
    if (url.pathname === "/gmail/v1/users/me/profile") {
      return Response.json({ emailAddress: "assistant@example.com" });
    }
    if (url.pathname === "/gmail/v1/users/me/messages") {
      return Response.json({
        messages: [...state.unread].map((id) => ({ id, threadId: id === "m1" ? "t1" : "t2" })),
      });
    }
    const modify = url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/(\w+)\/modify$/);
    if (modify) {
      await req.json();
      state.modified.push(modify[1]);
      state.unread.delete(modify[1]);
      return Response.json({});
    }
    if (url.pathname === "/gmail/v1/users/me/messages/send") {
      state.sent.push(await req.json());
      return Response.json({ id: "sent1" });
    }
    const get = url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/(\w+)$/);
    if (get) return Response.json(payloads[get[1]]);
    return Response.json({ error: url.pathname }, { status: 500 });
  });
  return { state, apiBase: () => `http://127.0.0.1:${port}`, close: () => server.shutdown() };
}

Deno.test("gmail: unread mail wakes the agent, reply threads, cursor advances", async () => {
  const api = fakeGmail();
  const events: AgentEvent[] = [];
  const trigger = new GmailEmailTrigger({
    clientId: "cid",
    clientSecret: "cs",
    refreshToken: "rt",
    label: "agent",
    pollSeconds: 60, // the first poll is immediate; the test never waits an interval
    fromAddresses: ["*@example.com"],
    apiBase: api.apiBase(),
    tokenUrl: `${api.apiBase()}/token`,
  });
  await trigger.start((event) => {
    events.push(event);
    return Promise.resolve(runResult("Filed it."));
  });

  await until(() => api.state.sent.length === 1 && api.state.modified.length === 2);
  await trigger.stop();
  await new Promise((r) => setTimeout(r, 50));
  await api.close();

  // One token refresh covered the whole cycle, and every call carried it.
  assertEquals(api.state.tokenRequests, 1);
  assertEquals([...api.state.authSeen], ["Bearer at1"]);

  // Only the allowlisted sender reached the model; both messages marked read.
  assertEquals(events.length, 1);
  assert(events[0].input.includes("Subject: Invoice 42"));
  assert(events[0].input.includes("Please file the attached invoice."));
  assert(events[0].input.includes("invoice.pdf"));
  assertEquals(events[0].conversationKey, "email:gmail:t1");
  assertEquals(api.state.modified.toSorted(), ["m1", "m2"]);

  const sent = api.state.sent[0];
  assertEquals(sent.threadId, "t1");
  const raw = atob(sent.raw.replace(/-/g, "+").replace(/_/g, "/"));
  assert(raw.includes("Subject: Re: Invoice 42"));
  assert(raw.includes("In-Reply-To: <orig@example.com>"));
  assert(raw.includes("To: Petra Lang <petra@example.com>"));
  assert(raw.includes("Filed it."));
});
