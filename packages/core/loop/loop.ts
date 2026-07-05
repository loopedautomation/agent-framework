import type { AgentConfig } from "../config/schema.ts";
import type { Message, Provider, Usage } from "../providers/types.ts";
import { ProviderError } from "../providers/types.ts";
import type { NativeTool } from "../tools/types.ts";

export type RunStatus = "ok" | "error_max_steps" | "error_provider";

export interface RunResult {
  status: RunStatus;
  /** The agent's final text (or a description of why the run ended). */
  reply: string;
  /** Inner-loop iterations consumed (LLM calls). */
  steps: number;
  usage: Usage;
  /** Full transcript including this run — feed back in as `history`. */
  messages: Message[];
}

export interface RunOptions {
  config: AgentConfig;
  provider: Provider;
  /** Static toolset, or a resolver called each iteration (tool search grows it mid-run). */
  tools?: NativeTool[] | (() => NativeTool[]);
  input: string;
  /** Prior conversation, e.g. from session memory. */
  history?: Message[];
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

    for (const call of completion.toolCalls) {
      const tool = toolsByName.get(call.name);
      const result = tool
        ? await tool.execute(call.arguments)
        : `unknown tool: ${call.name}. Available tools: ${[...toolsByName.keys()].join(", ")}`;
      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }
  }

  return finish(
    "error_max_steps",
    `run ended after ${config.limits.max_steps} steps without a final answer`,
  );
}
