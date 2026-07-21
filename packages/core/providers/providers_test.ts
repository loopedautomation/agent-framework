import { assert, assertEquals, assertRejects } from "@std/assert";
import { OpenAICompatibleProvider } from "./openai.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { CodexProvider } from "./codex.ts";
import { GeminiProvider } from "./gemini.ts";
import { createProvider, ProviderError, withRetry } from "./mod.ts";
import { parseAgentConfig } from "../config/load.ts";

function fakeFetch(status: number, body: unknown): typeof fetch & { calls: Request[] } {
  const calls: Request[] = [];
  const fn = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch & { calls: Request[] };
  fn.calls = calls;
  return fn;
}

Deno.test("openai adapter: maps request and parses tool calls", async () => {
  const f = fakeFetch(200, {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "echo", arguments: '{"message":"hi"}' },
        }],
      },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  });
  const provider = new OpenAICompatibleProvider({ apiKey: "k", fetch: f });
  const completion = await provider.complete({
    model: "gpt-5.4-mini",
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "echo", description: "d", inputSchema: { type: "object" } }],
  });

  assertEquals(completion.stopReason, "tool_calls");
  assertEquals(completion.toolCalls[0].name, "echo");
  assertEquals(completion.usage.inputTokens, 12);

  const sent = await f.calls[0].json();
  assertEquals(sent.model, "gpt-5.4-mini");
  assertEquals(sent.messages[0], { role: "system", content: "sys" });
  assertEquals(sent.tools[0].function.name, "echo");
});

Deno.test("openai adapter: tool-call turns are replayed with string content, never null", async () => {
  const f = fakeFetch(200, {
    choices: [{ finish_reason: "stop", message: { content: "done" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const provider = new OpenAICompatibleProvider({ apiKey: "k", fetch: f });
  await provider.complete({
    model: "gpt-5.4-mini",
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "echo", arguments: '{"message":"hi"}' }],
      },
      { role: "tool", content: "hi", toolCallId: "call_1" },
    ],
  });

  const sent = await f.calls[0].json();
  const assistant = sent.messages[1];
  assertEquals(assistant.content, "");
  assertEquals(assistant.tool_calls[0].id, "call_1");
});

Deno.test("openai adapter: 401 maps to a non-retryable auth error", async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "bad",
    fetch: fakeFetch(401, { error: "nope" }),
  });
  const err = await assertRejects(
    () => provider.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ProviderError,
  );
  assertEquals(err.kind, "auth");
  assertEquals(err.retryable, false);
});

Deno.test("anthropic adapter: converts tool results into user content blocks", async () => {
  const f = fakeFetch(200, {
    content: [{ type: "text", text: "done" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 2 },
  });
  const provider = new AnthropicProvider({ apiKey: "k", fetch: f });
  await provider.complete({
    model: "claude-sonnet-5",
    system: "sys",
    messages: [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "echo", arguments: "{}" }] },
      { role: "tool", toolCallId: "t1", content: "echo result" },
    ],
  });

  const sent = await f.calls[0].json();
  assertEquals(sent.system, "sys");
  assertEquals(sent.messages.length, 3);
  assertEquals(sent.messages[1].content[0].type, "tool_use");
  assertEquals(sent.messages[2].role, "user");
  assertEquals(sent.messages[2].content[0].type, "tool_result");
  assertEquals(sent.messages[2].content[0].tool_use_id, "t1");
});

Deno.test("anthropic adapter: parses tool_use blocks into tool calls", async () => {
  const f = fakeFetch(200, {
    content: [
      { type: "text", text: "let me check" },
      { type: "tool_use", id: "t9", name: "current_time", input: {} },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const provider = new AnthropicProvider({ apiKey: "k", fetch: f });
  const completion = await provider.complete({
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "time?" }],
  });
  assertEquals(completion.stopReason, "tool_calls");
  assertEquals(completion.toolCalls[0].id, "t9");
  assertEquals(completion.content, "let me check");
});

Deno.test("gemini adapter: maps request and parses function calls", async () => {
  const f = fakeFetch(200, {
    candidates: [{
      content: {
        parts: [
          { text: "let me check" },
          { functionCall: { name: "echo", args: { message: "hi" } } },
        ],
      },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 2 },
  });
  const provider = new GeminiProvider({ apiKey: "k", fetch: f });
  const completion = await provider.complete({
    model: "gemini-3.6-flash",
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "echo", description: "d", inputSchema: { type: "object" } }],
  });

  assertEquals(completion.stopReason, "tool_calls");
  assertEquals(completion.toolCalls[0].name, "echo");
  assertEquals(completion.toolCalls[0].arguments, '{"message":"hi"}');
  assertEquals(completion.content, "let me check");
  assertEquals(completion.usage, { inputTokens: 12, outputTokens: 5 });

  const call = f.calls[0];
  assert(call.url.endsWith("/v1beta/models/gemini-3.6-flash:generateContent"));
  assertEquals(call.headers.get("x-goog-api-key"), "k");
  const sent = await call.json();
  assertEquals(sent.systemInstruction, { parts: [{ text: "sys" }] });
  assertEquals(sent.contents[0], { role: "user", parts: [{ text: "hello" }] });
  assertEquals(sent.tools[0].functionDeclarations[0].name, "echo");
});

Deno.test("gemini adapter: tool results become functionResponse parts with the name recovered from the id", async () => {
  const f = fakeFetch(200, {
    candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  });
  const provider = new GeminiProvider({ apiKey: "k", fetch: f });
  await provider.complete({
    model: "gemini-3.6-flash",
    messages: [
      { role: "user", content: "run the tool" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "echo#0", name: "echo", arguments: '{"message":"hi"}' }],
      },
      { role: "tool", toolCallId: "echo#0", content: "hi" },
    ],
  });

  const sent = await f.calls[0].json();
  assertEquals(sent.contents.length, 3);
  assertEquals(sent.contents[1].role, "model");
  assertEquals(sent.contents[1].parts[0].functionCall.name, "echo");
  assertEquals(sent.contents[2].role, "user");
  assertEquals(sent.contents[2].parts[0].functionResponse, {
    id: "echo#0",
    name: "echo",
    response: { result: "hi" },
  });
});

Deno.test("gemini adapter: 401 maps to a non-retryable auth error", async () => {
  const provider = new GeminiProvider({
    apiKey: "bad",
    fetch: fakeFetch(401, { error: "nope" }),
  });
  const err = await assertRejects(
    () => provider.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ProviderError,
  );
  assertEquals(err.kind, "auth");
  assertEquals(err.retryable, false);
});

/** An unsigned JWT with the given payload — the provider only decodes, never verifies. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

function sseBody(response: unknown): string {
  return `data: {"type":"response.created"}\n\ndata: ${
    JSON.stringify({ type: "response.completed", response })
  }\n\n`;
}

/**
 * An SSE stream matching the broken-account shape: `response.completed`'s
 * `output` is empty, but `response.output_item.done` events (which carry the
 * fully finalized item) fired along the way. `items` are assigned
 * ascending `output_index`.
 */
function sseBodyWithReconstructedItems(
  response: Record<string, unknown>,
  items: unknown[],
): string {
  const doneEvents = items
    .map((item, output_index) =>
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`
    )
    .join("");
  return `data: {"type":"response.created"}\n\n${doneEvents}data: ${
    JSON.stringify({ type: "response.completed", response: { ...response, output: [] } })
  }\n\n`;
}

async function writeCodexAuth(tokens: Record<string, unknown>): Promise<string> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/auth.json`;
  await Deno.writeTextFile(path, JSON.stringify({ tokens }));
  return path;
}

Deno.test("codex adapter: maps request, auth headers, and parses function calls", async () => {
  const farFuture = Math.floor(Date.now() / 1000) + 3600;
  const authFile = await writeCodexAuth({
    access_token: fakeJwt({
      exp: farFuture,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
    }),
    refresh_token: "r1",
  });
  const f = fakeFetch(200, null);
  const fetchSse = ((input: RequestInfo | URL, init?: RequestInit) => {
    f.calls.push(new Request(input, init));
    return Promise.resolve(
      new Response(
        sseBody({
          status: "completed",
          output: [
            { type: "message", content: [{ type: "output_text", text: "checking" }] },
            { type: "function_call", call_id: "c1", name: "echo", arguments: '{"message":"hi"}' },
          ],
          usage: { input_tokens: 9, output_tokens: 4 },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const provider = new CodexProvider({ authFile, fetch: fetchSse });
  const completion = await provider.complete({
    model: "gpt-5-codex",
    system: "sys",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "echo", arguments: "{}" }] },
      { role: "tool", toolCallId: "c0", content: "ok" },
    ],
    tools: [{ name: "echo", description: "d", inputSchema: { type: "object" } }],
  });

  assertEquals(completion.stopReason, "tool_calls");
  assertEquals(completion.toolCalls[0], { id: "c1", name: "echo", arguments: '{"message":"hi"}' });
  assertEquals(completion.content, "checking");
  assertEquals(completion.usage, { inputTokens: 9, outputTokens: 4 });

  const call = f.calls[0];
  assert(call.url.endsWith("/responses"));
  assertEquals(call.headers.get("chatgpt-account-id"), "acct_1");
  assert(call.headers.get("authorization")!.startsWith("Bearer "));
  const sent = await call.json();
  assertEquals(sent.instructions, "sys");
  assertEquals(sent.stream, true);
  assertEquals(sent.store, false);
  assertEquals(sent.input[0], {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "hello" }],
  });
  assertEquals(sent.input[1], {
    type: "function_call",
    call_id: "c0",
    name: "echo",
    arguments: "{}",
  });
  assertEquals(sent.input[2], { type: "function_call_output", call_id: "c0", output: "ok" });
  assertEquals(sent.tools[0].name, "echo");
});

Deno.test("codex adapter: reconstructs a tool call when response.completed.output is empty", async () => {
  const farFuture = Math.floor(Date.now() / 1000) + 3600;
  const authFile = await writeCodexAuth({
    access_token: fakeJwt({
      exp: farFuture,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
    }),
    refresh_token: "r1",
  });
  const fetchSse = (() =>
    Promise.resolve(
      new Response(
        sseBodyWithReconstructedItems(
          { status: "completed", usage: { input_tokens: 9, output_tokens: 4 } },
          [{ type: "function_call", call_id: "c1", name: "echo", arguments: '{"message":"hi"}' }],
        ),
        { status: 200 },
      ),
    )) as typeof fetch;

  const provider = new CodexProvider({ authFile, fetch: fetchSse });
  const completion = await provider.complete({
    model: "gpt-5.5",
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "echo", description: "d", inputSchema: { type: "object" } }],
  });

  assertEquals(completion.stopReason, "tool_calls");
  assertEquals(completion.toolCalls[0], { id: "c1", name: "echo", arguments: '{"message":"hi"}' });
  assertEquals(completion.content, "");
});

Deno.test("codex adapter: reconstructs message text from output_item.done when output is empty and no delta streamed", async () => {
  const farFuture = Math.floor(Date.now() / 1000) + 3600;
  const authFile = await writeCodexAuth({
    access_token: fakeJwt({
      exp: farFuture,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
    }),
    refresh_token: "r1",
  });
  const fetchSse = (() =>
    Promise.resolve(
      new Response(
        sseBodyWithReconstructedItems(
          { status: "completed", usage: { input_tokens: 9, output_tokens: 4 } },
          [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }],
        ),
        { status: 200 },
      ),
    )) as typeof fetch;

  const provider = new CodexProvider({ authFile, fetch: fetchSse });
  const completion = await provider.complete({
    model: "gpt-5.5",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
  });

  assertEquals(completion.content, "Hello");
  assertEquals(completion.toolCalls, []);
});

Deno.test("codex adapter: refreshes an expired token and persists it", async () => {
  const expired = fakeJwt({
    exp: Math.floor(Date.now() / 1000) - 10,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
  });
  const fresh = fakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
  });
  const authFile = await writeCodexAuth({ access_token: expired, refresh_token: "r1" });

  const urls: string[] = [];
  const routed = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    urls.push(req.url);
    if (req.url.includes("auth.openai.com")) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: fresh, refresh_token: "r2" }), { status: 200 }),
      );
    }
    assertEquals(req.headers.get("authorization"), `Bearer ${fresh}`);
    return Promise.resolve(
      new Response(
        sseBody({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const provider = new CodexProvider({ authFile, fetch: routed });
  const completion = await provider.complete({
    model: "gpt-5-codex",
    messages: [{ role: "user", content: "x" }],
  });
  assertEquals(completion.content, "hi");
  assert(urls[0].includes("auth.openai.com"));

  const persisted = JSON.parse(await Deno.readTextFile(authFile));
  assertEquals(persisted.tokens.access_token, fresh);
  assertEquals(persisted.tokens.refresh_token, "r2");
});

Deno.test("codex adapter: inline CODEX_AUTH_JSON credentials work without a file", async () => {
  const authJson = JSON.stringify({
    tokens: {
      access_token: fakeJwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_2" },
      }),
      refresh_token: "r1",
    },
  });
  const fetchSse = (() =>
    Promise.resolve(
      new Response(
        sseBody({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      ),
    )) as typeof fetch;

  const provider = new CodexProvider({
    authFile: "/nonexistent/auth.json",
    authJson,
    fetch: fetchSse,
  });
  const completion = await provider.complete({
    model: "gpt-5-codex",
    messages: [{ role: "user", content: "x" }],
  });
  assertEquals(completion.content, "hi");
});

Deno.test("codex adapter: a static CODEX_ACCESS_TOKEN needs no file, refresh, or account id", async () => {
  const calls: Request[] = [];
  const fetchSse = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return Promise.resolve(
      new Response(
        sseBody({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  // An opaque (non-JWT) token: no exp to inspect, no account id to derive.
  const provider = new CodexProvider({
    authFile: "/nonexistent/auth.json",
    accessToken: "machine-token",
    fetch: fetchSse,
  });
  const completion = await provider.complete({
    model: "gpt-5-codex",
    messages: [{ role: "user", content: "x" }],
  });
  assertEquals(completion.content, "hi");
  assertEquals(calls.length, 1); // straight to the completion; no refresh call
  assertEquals(calls[0].headers.get("authorization"), "Bearer machine-token");
  assertEquals(calls[0].headers.get("chatgpt-account-id"), null);
});

Deno.test("codex adapter: missing credential file is a non-retryable auth error", async () => {
  const provider = new CodexProvider({ authFile: "/nonexistent/auth.json" });
  const err = await assertRejects(
    () => provider.complete({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ProviderError,
  );
  assertEquals(err.kind, "auth");
  assert(err.message.includes("codex login"));
});

Deno.test("createProvider builds codex from CODEX_HOME without any API key", () => {
  const model = parseAgentConfig(`
handle: p
description: d
model:
  provider: codex
  id: gpt-5-codex
purpose: s
`).model;
  const provider = createProvider(model, (n) => (n === "CODEX_HOME" ? "/tmp/codex" : undefined));
  assertEquals(provider.id, "codex");
});

Deno.test("withRetry retries retryable errors and gives up on the rest", async () => {
  let calls = 0;
  const result = await withRetry(() => {
    calls++;
    if (calls < 3) throw new ProviderError("busy", "rate_limit", 429);
    return Promise.resolve("ok");
  }, { sleep: () => Promise.resolve() });
  assertEquals(result, "ok");
  assertEquals(calls, 3);

  let authCalls = 0;
  await assertRejects(() =>
    withRetry(() => {
      authCalls++;
      throw new ProviderError("bad key", "auth", 401);
    }, { sleep: () => Promise.resolve() }), ProviderError);
  assertEquals(authCalls, 1);
});

Deno.test("createProvider resolves keys and tolerates keyless local endpoints", () => {
  const model = parseAgentConfig(`
handle: p
description: d
model:
  provider: openai-compatible
  id: m
purpose: s
`).model;

  // default env name
  const provider = createProvider(model, (n) => (n === "OPENAI_API_KEY" ? "key" : undefined));
  assertEquals(provider.id, "openai-compatible");

  // missing key without base_url → auth error
  let threw = false;
  try {
    createProvider(model, () => undefined);
  } catch (err) {
    threw = true;
    assert(err instanceof ProviderError && err.kind === "auth");
    assert(err.message.includes("OPENAI_API_KEY"));
  }
  assert(threw);

  // missing key with base_url (local model) → fine
  const local = { ...model, base_url: "http://localhost:11434/v1" };
  assertEquals(createProvider(local, () => undefined).id, "openai-compatible");
});
