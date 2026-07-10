import type { AgentConfig } from "../config/schema.ts";
import type { Message, Provider, Usage } from "../providers/types.ts";
import { ProviderError } from "../providers/types.ts";
import type { NativeTool } from "../tools/types.ts";

/** How a run ended: cleanly, out of steps, or on a provider failure. */
export type RunStatus = "ok" | "error_max_steps" | "error_provider";

/**
 * Injected as the final user turn of the wrap-up call when a run exhausts
 * `limits.max_steps` with the model still calling tools. The prompt itself is
 * request-only and never persisted; the summary it produces is.
 */
export const MAX_STEPS_WRAPUP_PROMPT =
  `You have reached the maximum number of steps for this run. Tools are no longer available; reply with plain text only.

Your reply must:
- state that the step limit was reached
- summarize what you have done so far
- list anything that remains unfinished
- say what should happen next

Do not attempt any further tool calls.`;

/**
 * Live progress from a run in flight, for interactive surfaces (the REPL's
 * run view). Purely observational: the loop never awaits a listener and the
 * run behaves identically without one.
 */
export type RunEvent =
  | { type: "step"; n: number }
  /** Interim commentary the model produced alongside tool calls (not the final reply). */
  | { type: "assistant"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; content: string; durationMs: number };

/** What one run produced. */
export interface RunResult {
  /** How the run ended. */
  status: RunStatus;
  /** The agent's final text (or a description of why the run ended). */
  reply: string;
  /** LLM calls consumed, including the wrap-up call after a capped run. */
  steps: number;
  /** Token usage summed over the run's LLM calls. */
  usage: Usage;
  /** Full transcript including this run — feed back in as `history`. */
  messages: Message[];
}

/** Inputs to {@linkcode runAgent}. */
export interface RunOptions {
  /** The agent's config; purpose becomes the system prompt, limits cap the run. */
  config: AgentConfig;
  /** The LLM backend to call. */
  provider: Provider;
  /** Static toolset, or a resolver called each iteration (tool search grows it mid-run). */
  tools?: NativeTool[] | (() => NativeTool[]);
  /** The user-facing input that starts the run. */
  input: string;
  /** Prior conversation, e.g. from session memory. */
  history?: Message[];
  /** Observes progress as the run happens; see {@linkcode RunEvent}. */
  onEvent?: (event: RunEvent) => void;
}

/**
 * The inner loop: one flat tool-use loop over a single message history.
 * Budgets end runs with typed statuses — the dead-man's switches for
 * unattended operation. Tool failures are results the model can adapt to.
 */
export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { config, provider, input } = opts;
  const resolveTools = typeof opts.tools === "function"
    ? opts.tools
    : () => opts.tools as NativeTool[] ?? [];
  const messages: Message[] = [...(opts.history ?? []), { role: "user", content: input }];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const emit = opts.onEvent ?? (() => {});
  let steps = 0;

  const finish = (status: RunStatus, reply: string): RunResult => ({
    status,
    reply,
    steps,
    usage,
    messages,
  });

  while (steps < config.limits.max_steps) {
    steps++;
    emit({ type: "step", n: steps });
    // Re-resolve per iteration: a search_tools call in the previous step may
    // have activated tools that must be callable now.
    const tools = resolveTools();
    const toolsByName = new Map(tools.map((t) => [t.def.name, t]));
    let completion;
    try {
      completion = await provider.complete({
        model: config.model.id,
        system: config.purpose,
        messages,
        tools: tools.map((t) => t.def),
      });
    } catch (err) {
      if (err instanceof ProviderError) {
        return finish("error_provider", `provider error (${err.kind}): ${err.message}`);
      }
      throw err;
    }

    usage.inputTokens += completion.usage.inputTokens;
    usage.outputTokens += completion.usage.outputTokens;
    messages.push({
      role: "assistant",
      content: completion.content,
      toolCalls: completion.toolCalls.length ? completion.toolCalls : undefined,
    });

    if (completion.toolCalls.length === 0) {
      return finish("ok", completion.content);
    }
    if (completion.content) emit({ type: "assistant", content: completion.content });

    for (const call of completion.toolCalls) {
      const tool = toolsByName.get(call.name);
      emit({ type: "tool_call", name: call.name, arguments: call.arguments });
      const startedAt = performance.now();
      const result = tool
        ? await tool.execute(call.arguments)
        : `unknown tool: ${call.name}. Available tools: ${[...toolsByName.keys()].join(", ")}`;
      emit({
        type: "tool_result",
        name: call.name,
        content: result,
        durationMs: performance.now() - startedAt,
      });
      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }
  }

  // Budget exhausted with the model still calling tools. Spend one extra
  // tool-less call so the run ends with the model's own account of where it
  // got to; downstream (chat replies, the runs table) sees that instead of a
  // canned string. The prompt stays out of the persisted transcript.
  steps++;
  try {
    const wrapup = await provider.complete({
      model: config.model.id,
      system: config.purpose,
      messages: [...messages, { role: "user", content: MAX_STEPS_WRAPUP_PROMPT }],
    });
    usage.inputTokens += wrapup.usage.inputTokens;
    usage.outputTokens += wrapup.usage.outputTokens;
    if (wrapup.content) {
      messages.push({ role: "assistant", content: wrapup.content });
      return finish("error_max_steps", wrapup.content);
    }
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
  }
  return finish(
    "error_max_steps",
    `run ended after ${config.limits.max_steps} steps without a final answer`,
  );
}
