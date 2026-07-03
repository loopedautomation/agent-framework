import { assert, assertEquals, assertRejects } from "@std/assert";
import { OpenAICompatibleProvider } from "./openai.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { createProvider, ProviderError, withRetry } from "./mod.ts";
import { parseAgentConfig } from "../config/load.ts";

function fakeFetch(status: number, body: unknown): typeof fetch & { calls: Request[] } {
  const calls: Request[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return new Response(JSON.stringify(body), { status });
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
nickname: p
description: d
model:
  provider: openai-compatible
  id: m
system_prompt: s
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
