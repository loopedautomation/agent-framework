import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import {
  type Completion,
  type CompletionRequest,
  type Provider,
  ProviderError,
} from "../providers/types.ts";
import { parseAgentConfig } from "../config/load.ts";
import { defineTool } from "../tools/types.ts";
import { runAgent } from "./loop.ts";

/** A provider that plays back a script of completions and records requests. */
function scripted(script: Partial<Completion>[]): Provider & { requests: CompletionRequest[] } {
  let i = 0;
  const requests: CompletionRequest[] = [];
  return {
    id: "mock",
    requests,
    complete(req: CompletionRequest): Promise<Completion> {
      requests.push({ ...req, messages: [...req.messages] }); // snapshot: the loop mutates its array
      const c = script[Math.min(i++, script.length - 1)];
      return Promise.resolve({
        content: c.content ?? "",
        toolCalls: c.toolCalls ?? [],
        stopReason: c.stopReason ?? ((c.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "end"),
        usage: c.usage ?? { inputTokens: 100, outputTokens: 50 },
      });
    },
  };
}

const CONFIG = parseAgentConfig(`
handle: loop-bot
description: loop test agent
model:
  provider: openai-compatible
  id: test-model
purpose: You are a test agent.
limits:
  max_steps: 3
`);

const echoTool = defineTool({
  name: "echo",
  description: "Echo a message back.",
  schema: z.strictObject({ message: z.string() }),
  readOnly: true,
  execute: ({ message }) => `echo: ${message}`,
});

Deno.test("runs tool call then final answer", async () => {
  const provider = scripted([
    { toolCalls: [{ id: "c1", name: "echo", arguments: '{"message":"hi"}' }] },
    { content: "The echo said hi." },
  ]);
  const result = await runAgent({ config: CONFIG, provider, tools: [echoTool], input: "echo hi" });

  assertEquals(result.status, "ok");
  assertEquals(result.reply, "The echo said hi.");
  assertEquals(result.steps, 2);
  assertEquals(result.usage.inputTokens, 200);
  // Tool result was fed back to the model:
  const toolMsg = result.messages.find((m) => m.role === "tool");
  assertEquals(toolMsg?.content, "echo: hi");
  // System prompt and tool defs reached the provider:
  assertEquals(provider.requests[0].system, "You are a test agent.");
  assertEquals(provider.requests[0].tools?.[0].name, "echo");
});

Deno.test("invalid tool arguments become a self-repair message, not a crash", async () => {
  const provider = scripted([
    { toolCalls: [{ id: "c1", name: "echo", arguments: "{not json" }] },
    { content: "recovered" },
  ]);
  const result = await runAgent({ config: CONFIG, provider, tools: [echoTool], input: "go" });
  assertEquals(result.status, "ok");
  const toolMsg = result.messages.find((m) => m.role === "tool");
  assert(toolMsg?.content.startsWith("invalid arguments"));
});

Deno.test("unknown tool names get a readable result listing available tools", async () => {
  const provider = scripted([
    { toolCalls: [{ id: "c1", name: "nonexistent", arguments: "{}" }] },
    { content: "done" },
  ]);
  const result = await runAgent({ config: CONFIG, provider, tools: [echoTool], input: "go" });
  const toolMsg = result.messages.find((m) => m.role === "tool");
  assert(toolMsg?.content.includes("unknown tool"));
  assert(toolMsg?.content.includes("echo"));
});

Deno.test("a capped run ends with the model's wrap-up summary", async () => {
  const call = { id: "c1", name: "echo", arguments: '{"message":"again"}' };
  const provider = scripted([
    { toolCalls: [call] },
    { toolCalls: [call] },
    { toolCalls: [call] },
    { content: "Step limit reached: echoed three times, nothing remains." },
  ]);
  const result = await runAgent({ config: CONFIG, provider, tools: [echoTool], input: "loop" });

  assertEquals(result.status, "error_max_steps");
  assertEquals(result.reply, "Step limit reached: echoed three times, nothing remains.");
  assertEquals(result.steps, 4); // 3 budgeted steps + the wrap-up call
  // The wrap-up call offers no tools and injects the prompt as the last user turn:
  const wrapupReq = provider.requests[3];
  assertEquals(wrapupReq.tools, undefined);
  const lastMsg = wrapupReq.messages.at(-1);
  assert(lastMsg?.role === "user" && lastMsg.content.includes("maximum number of steps"));
  // The injected prompt stays out of the transcript; the summary is kept:
  assert(
    !result.messages.some(
      (m) => m.role === "user" && m.content.includes("maximum number of steps"),
    ),
  );
  const final = result.messages.at(-1);
  assert(final?.role === "assistant" && final.content.includes("Step limit reached"));
});

Deno.test("a capped run falls back to the canned reply when the wrap-up produces no text", async () => {
  const provider = scripted([
    { toolCalls: [{ id: "c1", name: "echo", arguments: '{"message":"again"}' }] },
  ]);
  const result = await runAgent({ config: CONFIG, provider, tools: [echoTool], input: "loop" });
  assertEquals(result.status, "error_max_steps");
  assertEquals(result.reply, "run ended after 3 steps without a final answer");
  assertEquals(result.steps, 4);
});

Deno.test("a capped run falls back to the canned reply when the wrap-up call fails", async () => {
  const inner = scripted([
    { toolCalls: [{ id: "c1", name: "echo", arguments: '{"message":"again"}' }] },
  ]);
  let calls = 0;
  const provider: Provider = {
    id: "mock",
    complete(req) {
      if (++calls > 3) return Promise.reject(new ProviderError("boom", "overloaded"));
      return inner.complete(req);
    },
  };
  const result = await runAgent({ config: CONFIG, provider, tools: [echoTool], input: "loop" });
  assertEquals(result.status, "error_max_steps");
  assertEquals(result.reply, "run ended after 3 steps without a final answer");
});

Deno.test("history carries across runs", async () => {
  const provider = scripted([{ content: "second answer" }]);
  const first = await runAgent({
    config: CONFIG,
    provider: scripted([{ content: "first answer" }]),
    input: "first",
  });
  const second = await runAgent({
    config: CONFIG,
    provider,
    input: "second",
    history: first.messages,
  });
  assertEquals(second.messages.length, 4); // user, assistant, user, assistant
  assertEquals(provider.requests[0].messages.length, 3); // history + new user msg
});
