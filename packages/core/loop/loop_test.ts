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
import { runAgent, type RunEvent } from "./loop.ts";

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

Deno.test("contextTokens reports the final call's input tokens, not the sum", async () => {
  const provider = scripted([
    {
      toolCalls: [{ id: "c1", name: "echo", arguments: '{"message":"hi"}' }],
      usage: { inputTokens: 100, outputTokens: 10 },
    },
    { content: "done", usage: { inputTokens: 250, outputTokens: 10 } },
  ]);
  const result = await runAgent({ config: CONFIG, provider, tools: [echoTool], input: "go" });
  assertEquals(result.usage.inputTokens, 350);
  assertEquals(result.contextTokens, 250);
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

Deno.test("onEvent observes the run live: steps, commentary, tool calls and results", async () => {
  const provider = scripted([
    {
      content: "Let me check.",
      toolCalls: [{ id: "c1", name: "echo", arguments: '{"message":"hi"}' }],
    },
    { content: "The echo said hi." },
  ]);
  const events: RunEvent[] = [];
  const result = await runAgent({
    config: CONFIG,
    provider,
    tools: [echoTool],
    input: "echo hi",
    onEvent: (e) => events.push(e),
  });

  assertEquals(result.status, "ok");
  assertEquals(events.map((e) => e.type), [
    "step",
    "assistant",
    "tool_call",
    "tool_result",
    "step",
  ]);
  const [step1, assistant, call, toolResult] = events;
  assert(step1.type === "step" && step1.n === 1);
  assert(assistant.type === "assistant" && assistant.content === "Let me check.");
  assert(call.type === "tool_call" && call.name === "echo");
  assert(
    toolResult.type === "tool_result" &&
      toolResult.content === "echo: hi" &&
      toolResult.durationMs >= 0,
  );
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

Deno.test("an abort mid-step stops before further tools and provider calls", async () => {
  const provider = scripted([
    {
      toolCalls: [
        { id: "c1", name: "echo", arguments: '{"message":"hi"}' },
        { id: "c2", name: "echo", arguments: '{"message":"again"}' },
      ],
    },
    { content: "never reached" },
  ]);
  const controller = new AbortController();
  const result = await runAgent({
    config: CONFIG,
    provider,
    tools: [echoTool],
    input: "go",
    signal: controller.signal,
    onEvent: (e) => {
      if (e.type === "tool_result") controller.abort();
    },
  });

  assertEquals(result.status, "aborted");
  assertEquals(result.steps, 1);
  assertEquals(provider.requests.length, 1); // no second LLM call
  // The first tool ran; the second got a placeholder so the transcript
  // stays well-formed for the next run over this history.
  const toolMsgs = result.messages.filter((m) => m.role === "tool");
  assertEquals(toolMsgs.length, 2);
  assertEquals(toolMsgs[0].content, "echo: hi");
  assertEquals(toolMsgs[1].content, "(not run: run stopped)");
});

Deno.test("a pre-aborted signal ends the run before any provider call", async () => {
  const provider = scripted([{ content: "never reached" }]);
  const controller = new AbortController();
  controller.abort();
  const result = await runAgent({
    config: CONFIG,
    provider,
    input: "go",
    signal: controller.signal,
  });
  assertEquals(result.status, "aborted");
  assertEquals(result.steps, 0);
  assertEquals(provider.requests.length, 0);
});

Deno.test("onPersist hands over each step's messages, skipping history", async () => {
  const provider = scripted([
    { toolCalls: [{ id: "c1", name: "echo", arguments: '{"message":"one"}' }] },
    { toolCalls: [{ id: "c2", name: "echo", arguments: '{"message":"two"}' }] },
    { content: "done" },
  ]);
  const batches: string[][] = [];
  const result = await runAgent({
    config: CONFIG,
    provider,
    tools: [echoTool],
    input: "go",
    history: [{ role: "user", content: "old" }, { role: "assistant", content: "older" }],
    onPersist: (appended) => batches.push(appended.map((m) => m.content)),
  });

  // History is already on disk, so the first batch starts at this run's input.
  assertEquals(batches[0], ["go", "", "echo: one"]);
  assertEquals(batches[1], ["", "echo: two"]);
  assertEquals(batches[2], ["done"]);

  // Every message after the history was handed over exactly once, in order.
  assertEquals(
    batches.flat(),
    result.messages.slice(2).map((m) => m.content),
  );
});

Deno.test("onPersist still fires for the steps a failed run completed", async () => {
  let call = 0;
  const provider: Provider = {
    id: "half-broken",
    complete(): Promise<Completion> {
      call++;
      if (call === 1) {
        return Promise.resolve({
          content: "",
          toolCalls: [{ id: "c1", name: "echo", arguments: '{"message":"kept"}' }],
          stopReason: "tool_calls",
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      }
      return Promise.reject(new ProviderError("upstream is down", "overloaded"));
    },
  };
  const batches: string[][] = [];
  const result = await runAgent({
    config: CONFIG,
    provider,
    tools: [echoTool],
    input: "go",
    onPersist: (appended) => batches.push(appended.map((m) => m.content)),
  });

  assertEquals(result.status, "error_provider");
  // The step that did happen is durable even though the run ended badly.
  assertEquals(batches[0], ["go", "", "echo: kept"]);
});

/** CONFIG with a known price and whatever budgets the test needs. */
function budgetConfig(
  limits: string,
  pricing = "\n  pricing:\n    input_per_mtok: 5\n    output_per_mtok: 25",
) {
  return parseAgentConfig(`
handle: budget-bot
description: budget test agent
model:
  provider: openai-compatible
  id: test-model${pricing}
purpose: You are a test agent.
limits:
${limits}
`);
}

Deno.test("max_cost ends the run before the call that would breach it", async () => {
  // 100k in + 50k out at $5/$25 per Mtok is $1.75 a step.
  const usage = { inputTokens: 100_000, outputTokens: 50_000 };
  const provider = scripted([
    { toolCalls: [{ id: "c1", name: "echo", arguments: '{"message":"a"}' }], usage },
    { toolCalls: [{ id: "c2", name: "echo", arguments: '{"message":"b"}' }], usage },
    { content: "never reached", usage },
  ]);
  const result = await runAgent({
    config: budgetConfig("  max_steps: 10\n  max_cost: 3"),
    provider,
    tools: [echoTool],
    input: "spend",
  });

  assertEquals(result.status, "error_max_cost");
  // Two calls put the run at $3.50, over the $3 cap, so the third never runs.
  assertEquals(provider.requests.length, 2);
  assertEquals(result.steps, 2);
  assertEquals(result.cost, 3.5);
  assert(result.reply.includes("$3.50"));
  assert(result.reply.includes("$3.00"));
});

Deno.test("max_cost of 0 disables the cap", async () => {
  const usage = { inputTokens: 100_000, outputTokens: 50_000 };
  const provider = scripted([
    { toolCalls: [{ id: "c1", name: "echo", arguments: '{"message":"a"}' }], usage },
    { content: "done", usage },
  ]);
  const result = await runAgent({
    config: budgetConfig("  max_steps: 10\n  max_cost: 0"),
    provider,
    tools: [echoTool],
    input: "spend",
  });
  assertEquals(result.status, "ok");
  assertEquals(result.cost, 3.5);
});

Deno.test("an unpriced model reports no cost and cannot be capped", async () => {
  const provider = scripted([
    { toolCalls: [{ id: "c1", name: "echo", arguments: '{"message":"a"}' }] },
    { toolCalls: [{ id: "c2", name: "echo", arguments: '{"message":"b"}' }] },
    { content: "reached anyway" },
  ]);
  const result = await runAgent({
    config: budgetConfig("  max_steps: 10\n  max_cost: 0.01", ""),
    provider,
    tools: [echoTool],
    input: "spend",
  });

  // The cap is set and tiny, but nothing knows what this model costs, so it
  // cannot fire. The run completes and reports no cost rather than zero.
  assertEquals(result.status, "ok");
  assertEquals(result.cost, undefined);
});

Deno.test("model.pricing overrides the built-in price list", async () => {
  const provider = scripted([{
    content: "done",
    usage: { inputTokens: 100_000, outputTokens: 50_000 },
  }]);
  const result = await runAgent({
    // claude-opus-5 is in the built-in list at $5/$25; this says otherwise.
    config: parseAgentConfig(`
handle: budget-bot
description: budget test agent
model:
  provider: anthropic
  id: claude-opus-5
  pricing:
    input_per_mtok: 1
    output_per_mtok: 2
purpose: You are a test agent.
`),
    provider,
    input: "hi",
  });
  // 100k in at $1 + 50k out at $2 = $0.20, not the list price's $1.75.
  assertEquals(result.cost, 0.2);
});

Deno.test("max_runtime stops the run at the next step boundary", async () => {
  const slow: Provider = {
    id: "slow",
    async complete(): Promise<Completion> {
      await new Promise((r) => setTimeout(r, 60));
      return {
        content: "",
        toolCalls: [{ id: crypto.randomUUID(), name: "echo", arguments: '{"message":"x"}' }],
        stopReason: "tool_calls",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  const result = await runAgent({
    config: budgetConfig("  max_steps: 50\n  max_runtime: 0.1"),
    provider: slow,
    tools: [echoTool],
    input: "go",
  });

  assertEquals(result.status, "error_max_runtime");
  // It stopped early rather than running all 50 steps.
  assert(result.steps < 50);
  assert(result.reply.includes("over its 0.1s budget"));
});

Deno.test("a budgeted-out run skips the wrap-up call", async () => {
  const usage = { inputTokens: 100_000, outputTokens: 50_000 };
  const provider = scripted([
    { toolCalls: [{ id: "c1", name: "echo", arguments: '{"message":"a"}' }], usage },
    { toolCalls: [{ id: "c2", name: "echo", arguments: '{"message":"b"}' }], usage },
  ]);
  const result = await runAgent({
    config: budgetConfig("  max_steps: 2\n  max_cost: 3"),
    provider,
    tools: [echoTool],
    input: "spend",
  });

  // max_steps would spend a third call to summarize. Being out of money is
  // the one case where that call is exactly what must not happen.
  assertEquals(result.status, "error_max_cost");
  assertEquals(provider.requests.length, 2);
});
