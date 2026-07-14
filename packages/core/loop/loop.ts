import type { AgentConfig } from "../config/schema.ts";
import type { ImageContent, Message, Provider, Usage } from "../providers/types.ts";
import { ProviderError } from "../providers/types.ts";
import type { NativeTool } from "../tools/types.ts";

/**
 * How a run ended: cleanly, out of steps, or on a provider failure.
 * `rejected` means no run happened — the event was refused at the queue
 * (its conversation already held too much waiting work). `aborted` means
 * the run's abort signal fired (the /stop command) and the loop halted at
 * the next step boundary.
 */
export type RunStatus = "ok" | "error_max_steps" | "error_provider" | "rejected" | "aborted";

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
  | { type: "tool_result"; name: string; content: string; durationMs: number }
  /** A compaction summarize call has started, replacing `messageCount` messages. */
  | { type: "compaction"; phase: "start"; messageCount: number };

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
  /**
   * Input tokens of the run's final LLM call — the context size this
   * conversation has reached, as the provider reported it. Absent when the
   * run made no LLM call (built-ins, queue refusals).
   */
  contextTokens?: number;
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
  /** Images the input arrived with, for a model that can look at them (Plan 14). */
  images?: ImageContent[];
  /** Prior conversation, e.g. from session memory. */
  history?: Message[];
  /** Observes progress as the run happens; see {@linkcode RunEvent}. */
  onEvent?: (event: RunEvent) => void;
  /**
   * Cooperative cancellation: checked before each LLM call and between tool
   * executions. An in-flight provider call or tool run is never severed —
   * the loop stops at the next boundary, so the transcript stays well-formed.
   */
  signal?: AbortSignal;
  /**
   * Scrubs known secret values from anything that leaves the loop: tool
   * results before they enter the transcript, the run's reply, and every
   * emitted event. {@linkcode AgentService} passes the agent's redactor;
   * a loop run without one redacts nothing.
   */
  redact?: (text: string) => string;
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
  const messages: Message[] = [
    ...(opts.history ?? []),
    { role: "user", content: input, images: opts.images?.length ? opts.images : undefined },
  ];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const redact = opts.redact ?? ((text: string) => text);
  // Every event carries text a secret could ride out on: a tool result, the
  // model's own commentary, the arguments it built. Redact at the one gate.
  const listener = opts.onEvent;
  const emit = listener
    ? (event: RunEvent) => {
      switch (event.type) {
        case "assistant":
          return listener({ ...event, content: redact(event.content) });
        case "tool_call":
          return listener({ ...event, arguments: redact(event.arguments) });
        case "tool_result":
          return listener({ ...event, content: redact(event.content) });
        default:
          return listener(event);
      }
    }
    : () => {};
  let steps = 0;
  let contextTokens: number | undefined;

  const finish = (status: RunStatus, reply: string): RunResult => ({
    status,
    reply: redact(reply),
    steps,
    usage,
    contextTokens,
    messages,
  });

  const aborted = (): RunResult => finish("aborted", `run stopped after ${steps} steps`);

  while (steps < config.limits.max_steps) {
    if (opts.signal?.aborted) return aborted();
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
    contextTokens = completion.usage.inputTokens;
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
      // On abort, requested tools stop executing, but every pending call
      // still gets a placeholder result so the transcript stays well-formed
      // for the next run over this history.
      if (opts.signal?.aborted) {
        messages.push({ role: "tool", toolCallId: call.id, content: "(not run: run stopped)" });
        continue;
      }
      const tool = toolsByName.get(call.name);
      emit({ type: "tool_call", name: call.name, arguments: call.arguments });
      const startedAt = performance.now();
      // A permitted CLI or MCP server can always echo a credential back. The
      // result is scrubbed here, before it becomes a message the model reads
      // and the store keeps.
      const result = redact(
        tool
          ? await tool.execute(call.arguments)
          : `unknown tool: ${call.name}. Available tools: ${[...toolsByName.keys()].join(", ")}`,
      );
      emit({
        type: "tool_result",
        name: call.name,
        content: result,
        durationMs: performance.now() - startedAt,
      });
      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }
  }

  if (opts.signal?.aborted) return aborted();

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
    contextTokens = wrapup.usage.inputTokens;
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
