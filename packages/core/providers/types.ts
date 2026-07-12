/** A tool made available to the model. */
export interface ToolDef {
  /** Tool name as presented to the model. */
  name: string;
  /** What the tool does; the model reads this to decide when to call it. */
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** Read-only tools may run concurrently; mutating tools serialize. */
  readOnly?: boolean;
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  /** Provider-assigned id, echoed back in the tool result message. */
  id: string;
  /** Name of the tool to invoke. */
  name: string;
  /** Raw JSON string as produced by the model - validated before execution. */
  arguments: string;
}

/** An image the model can look at, carried alongside the text of a user turn. */
export interface ImageContent {
  /** The image's media type. Only formats every provider dialect accepts. */
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** The image bytes, base64-encoded, with no `data:` prefix. */
  data: string;
}

/**
 * One turn in a conversation: user input, assistant output, or a tool result.
 *
 * `content` is a string on every role, and images ride beside it rather than
 * turning it into a block union. That keeps every reader of a message — the
 * compactor, the redactor, the session store, the REPL — working on text, and
 * confines multimodality to the two places that have to know about it: the
 * trigger that resolves the bytes and the provider that ships them. The model
 * answers in text, so only the user turn carries images (Plan 14).
 */
export type Message =
  | { role: "user"; content: string; images?: ImageContent[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** Token counts for one or more completions. */
export interface Usage {
  /** Tokens sent to the model. */
  inputTokens: number;
  /** Tokens produced by the model. */
  outputTokens: number;
}

/** Why a completion stopped: finished, wants tool results, or hit the token cap. */
export type StopReason = "end" | "tool_calls" | "max_tokens";

/** One model response, normalized across providers. */
export interface Completion {
  /** The model's text output. */
  content: string;
  /** Tool invocations the model requested; empty when none. */
  toolCalls: ToolCall[];
  /** Why the model stopped. */
  stopReason: StopReason;
  /** Token usage for this completion. */
  usage: Usage;
}

/** A single completion call: model, context, and sampling options. */
export interface CompletionRequest {
  /** Model identifier, e.g. gpt-5.4-mini or claude-sonnet-5. */
  model: string;
  /** System prompt. */
  system?: string;
  /** Conversation history, oldest first. */
  messages: Message[];
  /** Tools the model may call. */
  tools?: ToolDef[];
  /** Cap on output tokens. */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
}

/** An LLM backend: takes a completion request, returns a normalized completion. */
export interface Provider {
  /** Provider identifier, e.g. "anthropic" or "openai-compatible". */
  readonly id: string;
  /** Run one completion against the backend. */
  complete(req: CompletionRequest): Promise<Completion>;
}

/** Classified provider failure: drives retry behavior. */
export type ProviderErrorKind = "auth" | "rate_limit" | "overloaded" | "bad_request" | "unknown";

/** An error from a provider call, classified by kind. */
export class ProviderError extends Error {
  /** Create a ProviderError with a message, a kind, and an optional HTTP status. */
  constructor(
    message: string,
    /** Failure classification. */
    readonly kind: ProviderErrorKind,
    /** HTTP status code, when the failure came from a response. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Rate limits and overloads are worth retrying; auth/bad requests are not. */
  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "overloaded";
  }
}

/** Map an HTTP status code to a ProviderErrorKind. */
export function errorKindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "overloaded";
  if (status >= 400) return "bad_request";
  return "unknown";
}
