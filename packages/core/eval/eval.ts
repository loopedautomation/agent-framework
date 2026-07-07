// The eval harness (Plan 9): cases in YAML beside the agent file, run through
// the real agent loop against the real model, with tool execution mocked so
// CI never opens a GitHub issue. `af test` is the frontend.

import { parse } from "@std/yaml";
import { z } from "zod";
import type { AgentConfig } from "../config/schema.ts";
import { ConfigError } from "../config/load.ts";
import type { Provider, Usage } from "../providers/types.ts";
import type { NativeTool } from "../tools/types.ts";
import { Store } from "../store/store.ts";
import { AgentService } from "../runtime/service.ts";

const checkSchema = z.union([
  z.strictObject({ status: z.enum(["ok", "error_max_steps", "error_provider"]) }),
  z.strictObject({ reply_contains: z.string().min(1) }),
  z.strictObject({ reply_matches: z.string().min(1) }),
  z.strictObject({ tool_called: z.string().min(1) }),
  z.strictObject({ tool_not_called: z.string().min(1) }),
  z.strictObject({ max_steps_used: z.number().int().positive() }),
]);

const evalCaseSchema = z.strictObject({
  name: z.string().min(1),
  input: z.string().min(1),
  mocks: z.record(z.string(), z.string()).optional(),
  checks: z.array(checkSchema).min(1),
});

const evalFileSchema = z.strictObject({
  cases: z.array(evalCaseSchema).min(1),
});

// The parsed shapes are hand-written interfaces so the public API carries
// explicit types (JSR's no-slow-types rule); drift guards at the bottom keep
// them honest against the schemas.

/** One assertion against a case's outcome. */
export type EvalCheck =
  | { status: "ok" | "error_max_steps" | "error_provider" }
  | { reply_contains: string }
  | { reply_matches: string }
  | { tool_called: string }
  | { tool_not_called: string }
  | { max_steps_used: number };

/** One test case: an input, canned tool results, and checks. */
export interface EvalCase {
  /** The case's name, shown one per line in `af test` output. */
  name: string;
  /** The user-facing input that starts the run. */
  input: string;
  /** Canned tool results by tool name; a call to any other tool fails the case. */
  mocks?: Record<string, string>;
  /** Assertions against the run's outcome. */
  checks: EvalCheck[];
}

/** A parsed test file: the `cases:` list. */
export interface EvalFile {
  /** The file's test cases, run in order. */
  cases: EvalCase[];
}

/** Parse and validate test-case YAML. Throws ConfigError with a readable message. */
export function parseEvalFile(yamlText: string, source?: string): EvalFile {
  let data: unknown;
  try {
    data = parse(yamlText);
  } catch (err) {
    throw new ConfigError(
      `${source ?? "test file"} is not valid YAML: ${(err as Error).message}`,
      source,
    );
  }
  const result = evalFileSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigError(
      `${source ?? "test file"} is not a valid test file:\n${
        z.prettifyError(result.error as z.ZodError)
      }`,
      source,
    );
  }
  return result.data;
}

/** What one case produced. */
export interface CaseResult {
  /** The case's name, verbatim. */
  name: string;
  /** True when every check passed and no unmocked tool was called. */
  passed: boolean;
  /** Human-readable failures, one per failed check. */
  failures: string[];
  /** The agent's final reply (empty when the run aborted on an unmocked call). */
  reply: string;
  /** LLM calls the case consumed. */
  steps: number;
  /** Token usage for the case. */
  usage: Usage;
}

/** Inputs to {@linkcode runEvalCases}. */
export interface EvalRunOptions {
  /** The agent under test. */
  config: AgentConfig;
  /** Base for resolving relative paths in the config (skills). Defaults to cwd. */
  baseDir?: string;
  /** Defaults to createProvider(config.model); injectable for tests. */
  provider?: Provider;
}

// Framework-owned tools with no external side effects: safe to run for real
// against the in-memory store, so cases don't have to mock the plumbing.
const FRAMEWORK_TOOLS = new Set([
  "current_time",
  "read_skill",
  "remember",
  "recall",
  "list_memories",
  "forget",
  "search_tools",
]);

// Aborts the run the moment the model calls a tool no mock covers — a
// surprise tool call is exactly what a test should surface.
class UnmockedToolCall extends Error {
  constructor(readonly tool: string) {
    super(`unmocked tool call: ${tool}`);
    this.name = "UnmockedToolCall";
  }
}

/**
 * Run test cases through the real agent loop: real model, real system-prompt
 * assembly, in-memory store, tool execution intercepted. A mocked tool
 * returns its canned result; a framework tool runs for real; anything else
 * fails the case.
 */
export async function runEvalCases(
  cases: EvalCase[],
  opts: EvalRunOptions,
): Promise<CaseResult[]> {
  const state = { mocks: {} as Record<string, string>, calls: [] as string[] };
  const service = new AgentService({
    config: opts.config,
    provider: opts.provider,
    baseDir: opts.baseDir,
    store: new Store(":memory:"),
    identity: { name: opts.config.handle, isNew: false },
    wrapTool: (tool: NativeTool): NativeTool => ({
      def: tool.def,
      execute: (rawArgs: string) => {
        state.calls.push(tool.def.name);
        const mock = state.mocks[tool.def.name];
        if (mock !== undefined) return Promise.resolve(mock);
        if (FRAMEWORK_TOOLS.has(tool.def.name)) return tool.execute(rawArgs);
        return Promise.reject(new UnmockedToolCall(tool.def.name));
      },
    }),
  });

  try {
    const results: CaseResult[] = [];
    for (const c of cases) {
      state.mocks = c.mocks ?? {};
      state.calls = [];
      try {
        const run = await service.handle({
          id: crypto.randomUUID(),
          trigger: "test",
          input: c.input,
        });
        const failures = c.checks
          .map((check) => checkFailure(check, run.reply, run.status, run.steps, state.calls))
          .filter((f): f is string => f !== undefined);
        results.push({
          name: c.name,
          passed: failures.length === 0,
          failures,
          reply: run.reply,
          steps: run.steps,
          usage: run.usage,
        });
      } catch (err) {
        if (!(err instanceof UnmockedToolCall)) throw err;
        results.push({
          name: c.name,
          passed: false,
          failures: [
            `called ${err.tool} with no mock — add it under mocks: or tighten the agent's job`,
          ],
          reply: "",
          steps: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      }
    }
    return results;
  } finally {
    await service.stop();
  }
}

function checkFailure(
  check: EvalCheck,
  reply: string,
  status: string,
  steps: number,
  calls: string[],
): string | undefined {
  if ("status" in check) {
    return status === check.status ? undefined : `status: expected ${check.status}, got ${status}`;
  }
  if ("reply_contains" in check) {
    return reply.includes(check.reply_contains)
      ? undefined
      : `reply_contains "${check.reply_contains}": reply was ${JSON.stringify(clip(reply))}`;
  }
  if ("reply_matches" in check) {
    return new RegExp(check.reply_matches).test(reply)
      ? undefined
      : `reply_matches /${check.reply_matches}/: reply was ${JSON.stringify(clip(reply))}`;
  }
  if ("tool_called" in check) {
    return calls.includes(check.tool_called)
      ? undefined
      : `tool_called ${check.tool_called}: tools called were ${
        calls.length ? [...new Set(calls)].join(", ") : "none"
      }`;
  }
  if ("tool_not_called" in check) {
    return calls.includes(check.tool_not_called)
      ? `tool_not_called ${check.tool_not_called}: it was called`
      : undefined;
  }
  return steps <= check.max_steps_used
    ? undefined
    : `max_steps_used ${check.max_steps_used}: run took ${steps} steps`;
}

function clip(text: string, max = 120): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// Compile-time drift guards: each fails if the hand-written type and the
// schema's inferred type stop being mutually assignable.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _evalFileInSync: MutuallyAssignable<EvalFile, z.infer<typeof evalFileSchema>> = true;
const _evalCheckInSync: MutuallyAssignable<EvalCheck, z.infer<typeof checkSchema>> = true;
