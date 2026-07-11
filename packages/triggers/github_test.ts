import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { AgentEvent, RunResult } from "@looped/core";
import {
  eventAllowed,
  githubConversationKey,
  GithubTrigger,
  renderGithubEvent,
  repoAllowed,
  verifyGithubSignature,
} from "./github.ts";

const SECRET = "It's a Secret to Everybody";

// GitHub's own documented test vector for X-Hub-Signature-256.
Deno.test("verifyGithubSignature: accepts GitHub's documented vector", async () => {
  assert(
    await verifyGithubSignature({
      secret: SECRET,
      body: "Hello, World!",
      signature: "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    }),
  );
});

Deno.test("verifyGithubSignature: rejects a wrong signature and a wrong secret", async () => {
  assert(
    !(await verifyGithubSignature({
      secret: SECRET,
      body: "Hello, World!",
      signature: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
    })),
  );
  assert(
    !(await verifyGithubSignature({
      secret: "some other secret",
      body: "Hello, World!",
      signature: "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    })),
  );
});

Deno.test("eventAllowed: event, event.action and * patterns", () => {
  assert(eventAllowed("pull_request", "opened", ["pull_request"]));
  assert(eventAllowed("pull_request", "opened", ["pull_request.opened"]));
  assert(eventAllowed("pull_request", "opened", ["pull_request.*"]));
  assert(eventAllowed("pull_request", "opened", ["*"]));
  assert(eventAllowed("push", undefined, ["push"]));
  assert(!eventAllowed("pull_request", "closed", ["pull_request.opened"]));
  assert(!eventAllowed("issues", "opened", ["pull_request"]));
  assert(!eventAllowed("push", undefined, ["pull_request", "issues.opened"]));
});

Deno.test("repoAllowed: owner/repo, owner/* and * patterns", () => {
  assert(repoAllowed("looped/agent-framework", ["looped/agent-framework"]));
  assert(repoAllowed("Looped/Agent-Framework", ["looped/agent-framework"]));
  assert(repoAllowed("looped/agent-framework", ["looped/*"]));
  assert(repoAllowed("looped/agent-framework", ["*"]));
  assert(!repoAllowed("other/repo", ["looped/*"]));
  assert(repoAllowed(undefined, ["*"]));
  assert(!repoAllowed(undefined, ["looped/*"]));
});

Deno.test("renderGithubEvent: pull_request gets tailored fields", () => {
  const text = renderGithubEvent("pull_request", {
    action: "opened",
    repository: { full_name: "looped/agent-framework" },
    sender: { login: "ratulmaharaj" },
    pull_request: {
      number: 42,
      title: "Add a github trigger",
      state: "open",
      body: "Wakes the agent on webhook events.",
      html_url: "https://github.com/looped/agent-framework/pull/42",
      head: { ref: "feat/github-trigger" },
      base: { ref: "main" },
    },
  });
  assertStringIncludes(text, "GitHub event: pull_request.opened");
  assertStringIncludes(text, "Repository: looped/agent-framework");
  assertStringIncludes(text, "Pull request: #42 Add a github trigger");
  assertStringIncludes(text, "Branch: feat/github-trigger -> main");
  assertStringIncludes(text, "Wakes the agent on webhook events.");
});

Deno.test("renderGithubEvent: unknown events fall back to a pruned payload", () => {
  const text = renderGithubEvent("deployment_status", {
    action: "created",
    repository: { full_name: "looped/agent-framework" },
    sender: { login: "ratulmaharaj" },
    deployment_status: { state: "success", environment: "production" },
  });
  assertStringIncludes(text, "GitHub event: deployment_status.created");
  assertStringIncludes(text, '"state": "success"');
  // The header already carries these; the fallback JSON drops them.
  assert(!text.includes('"full_name"'));
});

Deno.test("githubConversationKey: PR and issue events thread, pushes run one-shot", () => {
  assertEquals(
    githubConversationKey({
      repository: { full_name: "a/b" },
      pull_request: { number: 7 },
    }),
    "github:a/b#7",
  );
  assertEquals(
    githubConversationKey({ repository: { full_name: "a/b" }, issue: { number: 3 } }),
    "github:a/b#3",
  );
  assertEquals(githubConversationKey({ repository: { full_name: "a/b" }, ref: "main" }), undefined);
});

async function signed(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function okResult(): RunResult {
  return {
    status: "ok",
    reply: "done",
    steps: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    messages: [],
  };
}

Deno.test("GithubTrigger: verifies, filters and acks deliveries", async () => {
  const seen: AgentEvent[] = [];
  let port = 0;
  const trigger = new GithubTrigger({
    path: "/github",
    port: 0,
    secret: SECRET,
    events: ["pull_request.opened"],
    repos: ["looped/*"],
    onListen: (addr) => (port = addr.port),
  });
  await trigger.start((event) => {
    seen.push(event);
    return Promise.resolve(okResult());
  });

  const post = async (
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${port}/github`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    return { status: res.status, json: await res.json() };
  };

  // Unsigned delivery: 401, no run.
  const unsigned = await post("{}", { "x-github-event": "pull_request" });
  assertEquals(unsigned.status, 401);

  // The ping handshake answers without a run.
  const pingBody = JSON.stringify({ zen: "Design for failure." });
  const ping = await post(pingBody, {
    "x-github-event": "ping",
    "x-hub-signature-256": await signed(pingBody),
  });
  assertEquals(ping.status, 200);
  assertEquals(ping.json.pong, true);

  // An event outside the allowlist is acknowledged and dropped.
  const closedBody = JSON.stringify({
    action: "closed",
    repository: { full_name: "looped/agent-framework" },
    pull_request: { number: 1 },
  });
  const closed = await post(closedBody, {
    "x-github-event": "pull_request",
    "x-hub-signature-256": await signed(closedBody),
  });
  assertEquals(closed.json.ignored, "event not in events list");

  // A repository outside the allowlist is acknowledged and dropped.
  const foreignBody = JSON.stringify({
    action: "opened",
    repository: { full_name: "someone/else" },
    pull_request: { number: 1 },
  });
  const foreign = await post(foreignBody, {
    "x-github-event": "pull_request",
    "x-hub-signature-256": await signed(foreignBody),
  });
  assertEquals(foreign.json.ignored, "repository not in repos list");

  // A matching delivery is acked 202 and wakes the agent.
  const openedBody = JSON.stringify({
    action: "opened",
    repository: { full_name: "looped/agent-framework" },
    sender: { login: "ratulmaharaj" },
    pull_request: { number: 42, title: "Add a github trigger", head: {}, base: {} },
  });
  const opened = await post(openedBody, {
    "x-github-event": "pull_request",
    "x-github-delivery": "delivery-1",
    "x-hub-signature-256": await signed(openedBody),
  });
  assertEquals(opened.status, 202);

  await trigger.stop();
  assertEquals(seen.length, 1);
  assertEquals(seen[0].id, "delivery-1");
  assertEquals(seen[0].conversationKey, "github:looped/agent-framework#42");
  assertStringIncludes(seen[0].input, "Pull request: #42");
});
