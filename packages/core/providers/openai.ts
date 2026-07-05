import {
  type Completion,
  type CompletionRequest,
  errorKindForStatus,
  type Message,
  type Provider,
  ProviderError,
  type StopReason,
  type ToolCall,
} from "./types.ts";
import { withRetry } from "./retry.ts";

export interface OpenAICompatibleOptions {
  apiKey: string;
  /** Defaults to the OpenAI API; point at Ollama/vLLM/any proxy. */
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

function toWireMessages(system: string | undefined, messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = [];
  if (system) wire.push({ role: "system", content: system });
  for (const m of messages) {
    switch (m.role) {
      case "user":
        wire.push({ role: "user", content: m.content });
        break;
      case "assistant":
        wire.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls?.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
        break;
      case "tool":
        wire.push({ role: "tool", content: m.content, tool_call_id: m.toolCallId });
        break;
    }
  }
  return wire;
}

function toStopReason(finish: string | undefined, toolCalls: ToolCall[]): StopReason {
  if (toolCalls.length > 0) return "tool_calls";
  if (finish === "length") return "max_tokens";
  return "end";
}

/** Provider adapter for the OpenAI chat-completions dialect. */
export class OpenAICompatibleProvider implements Provider {
  /** Provider identifier. */
  readonly id = "openai-compatible";
  #apiKey: string;
  #baseUrl: string;
  #fetch: typeof fetch;

  /** Create the provider from an API key, optional base URL, and an injectable fetch for tests. */
  constructor(opts: OpenAICompatibleOptions) {
    this.#apiKey = opts.apiKey;
    this.#baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.#fetch = opts.fetch ?? fetch;
  }

  /** Run one completion, with retry on retryable provider errors. */
  complete(req: CompletionRequest): Promise<Completion> {
    return withRetry(() => this.#completeOnce(req));
  }

  async #completeOnce(req: CompletionRequest): Promise<Completion> {
    const body = {
      model: req.model,
      messages: toWireMessages(req.system, req.messages),
      tools: req.tools?.length
        ? req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        }))
        : undefined,
      max_completion_tokens: req.maxTokens,
      temperature: req.temperature,
    };

    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderError(`request failed: ${(err as Error).message}`, "overloaded");
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `provider returned ${res.status}: ${text.slice(0, 300)}`,
        errorKindForStatus(res.status),
        res.status,
      );
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new ProviderError("provider response has no choices[0].message", "unknown");
    }

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc: WireToolCall) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    return {
      content: choice.message.content ?? "",
      toolCalls,
      stopReason: toStopReason(choice.finish_reason, toolCalls),
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}
