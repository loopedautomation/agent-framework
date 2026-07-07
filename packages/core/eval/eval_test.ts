import { assert, assertEquals, assertThrows } from "@std/assert";
import type { Completion, CompletionRequest, Provider } from "../providers/types.ts";
import { parseAgentConfig } from "../config/load.ts";
import { ConfigError } from "../config/load.ts";
import { parseEvalFile, runEvalCases } from "./eval.ts";

/** A provider that plays back a script of completions and records requests. */
function scripted(script: Partial<Completion>[]): Provider & { requests: CompletionRequest[] } {
  let i = 0;
  const requests: CompletionRequest[] = [];
  return {
    id: "mock",
    requests,
    complete(req: CompletionRequest): Promise<Completion> {
      requests.push({ ...req, messages: [...req.messages] });
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
handle: eval-bot
description: eval test agent
model:
  provider: openai-compatible
  id: test-model
purpose: You file issues.
permissions:
  run: [gh]
limits:
  max_steps: 3
`);

Deno.test("parseEvalFile accepts the documented shape", () => {
  const file = parseEvalFile(`
cases:
  - name: files an issue
    input: "the export button 500s"
    mocks:
      run_bash: "https://github.com/o/r/issues/42"
    checks:
      - status: ok
      - tool_called: run_bash
      - reply_contains: "issues/42"
  - name: ignores chatter
    input: "lunch anyone?"
    checks:
      - tool_not_called: run_bash
`);
  assertEquals(file.cases.length, 2);
  assertEquals(file.cases[0].mocks, { run_bash: "https://github.com/o/r/issues/42" });
});

Deno.test("parseEvalFile rejects unknown checks with a readable error", () => {
  assertThrows(
    () => parseEvalFile(`cases:\n  - name: x\n    input: y\n    checks:\n      - reply_rhymes: z`),
    ConfigError,
    "not a valid test file",
  );
});

Deno.test("a mocked tool returns the canned result and checks pass", async () => {
  const provider = scripted([
    { toolCalls: [{ id: "c1", name: "run_bash", arguments: '{"command":"gh issue create"}' }] },
    { content: "Filed: https://github.com/o/r/issues/42" },
  ]);
  const results = await runEvalCases([{
    name: "files an issue",
    input: "the export button 500s",
    mocks: { run_bash: "https://github.com/o/r/issues/42" },
    checks: [
      { status: "ok" },
      { tool_called: "run_bash" },
      { reply_contains: "issues/42" },
      { reply_matches: "issues/\\d+" },
      { max_steps_used: 2 },
    ],
  }], { config: CONFIG, provider });

  assertEquals(results.length, 1);
  assertEquals(results[0].failures, []);
  assert(results[0].passed);
  assertEquals(results[0].steps, 2);
  // The canned result reached the model as the tool turn.
  const toolTurn = provider.requests[1].messages.find((m) => m.role === "tool");
  assertEquals(toolTurn?.content, "https://github.com/o/r/issues/42");
});

Deno.test("failed checks report expected vs actual", async () => {
  const provider = scripted([{ content: "sorry, can't help" }]);
  const results = await runEvalCases([{
    name: "files an issue",
    input: "the export button 500s",
    checks: [{ tool_called: "run_bash" }, { reply_contains: "issues/42" }],
  }], { config: CONFIG, provider });

  assert(!results[0].passed);
  assertEquals(results[0].failures.length, 2);
  assert(results[0].failures[0].includes("tool_called run_bash"));
  assert(results[0].failures[1].includes("sorry, can't help"));
});

Deno.test("an unmocked tool call fails the case instead of executing", async () => {
  const provider = scripted([
    { toolCalls: [{ id: "c1", name: "run_bash", arguments: '{"command":"gh issue create"}' }] },
    { content: "done" },
  ]);
  const results = await runEvalCases([{
    name: "surprise tool call",
    input: "the export button 500s",
    checks: [{ status: "ok" }],
  }], { config: CONFIG, provider });

  assert(!results[0].passed);
  assert(results[0].failures[0].includes("run_bash with no mock"));
});

Deno.test("tool_not_called passes when the model stays quiet", async () => {
  const provider = scripted([{ content: "I file bug reports; that's not one." }]);
  const results = await runEvalCases([{
    name: "ignores chatter",
    input: "lunch anyone?",
    checks: [{ tool_not_called: "run_bash" }, { status: "ok" }],
  }], { config: CONFIG, provider });

  assert(results[0].passed);
});

Deno.test("framework tools run for real without a mock", async () => {
  const provider = scripted([
    { toolCalls: [{ id: "c1", name: "current_time", arguments: "{}" }] },
    { content: "the time is now" },
  ]);
  const results = await runEvalCases([{
    name: "asks the clock",
    input: "what time is it?",
    checks: [{ status: "ok" }, { tool_called: "current_time" }],
  }], { config: CONFIG, provider });

  assert(results[0].passed);
});
