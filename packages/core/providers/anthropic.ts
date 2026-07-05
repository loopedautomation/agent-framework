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

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface WireMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/**
 * Anthropic's dialect has no `tool` role: results are content blocks in a
 * user message, and consecutive same-role messages must be merged.
 */
function toWireMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = [];
  const push = (role: "user" | "assistant", block: ContentBlock) => {
    const last = wire.at(-1);
    if (last?.role === role) last.content.push(block);
    else wire.push({ role, content: [block] });
  };
  for (const m of messages) {
    switch (m.role) {
      case "user":
        push("user", { type: "text", text: m.content });
        break;
      case "assistant":
        if (m.content) push("assistant", { type: "text", text: m.content });
        for (const tc of m.toolCalls ?? []) {
          push("assistant", {
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.arguments || "{}"),
          });
        }
        break;
      case "tool":
        push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
        break;
    }
  }
  return wire;
}

function toStopReason(reason: string | undefined): StopReason {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "max_tokens";
  return "end";
}

/** Provider adapter for the Anthropic Messages API. */
export class AnthropicProvider implements Provider {
  /** Provider identifier. */
  readonly id = "anthropic";
  #apiKey: string;
  #baseUrl: string;
  #fetch: typeof fetch;

  /** Create the provider from an API key, optional base URL, and an injectable fetch for tests. */
  constructor(opts: AnthropicOptions) {
    this.#apiKey = opts.apiKey;
    this.#baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.#fetch = opts.fetch ?? fetch;
  }

  /** Run one completion, with retry on retryable provider errors. */
  complete(req: CompletionRequest): Promise<Completion> {
    return withRetry(() => this.#completeOnce(req));
  }

  async #completeOnce(req: CompletionRequest): Promise<Completion> {
    const body = {
      model: req.model,
      system: req.system,
      messages: toWireMessages(req.messages),
      tools: req.tools?.length
        ? req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        }))
        : undefined,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature,
    };

    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": "2023-06-01",
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
    const blocks: ContentBlock[] = data.content ?? [];
    const content = blocks
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolCalls: ToolCall[] = blocks
      .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }));

    return {
      content,
      toolCalls,
      stopReason: toStopReason(data.stop_reason),
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
    };
  }
}
