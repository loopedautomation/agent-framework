/** A tool made available to the model. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** Read-only tools may run concurrently; mutating tools serialize. */
  readOnly?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model — validated before execution. */
  arguments: string;
}

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type StopReason = "end" | "tool_calls" | "max_tokens";

export interface Completion {
  content: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: Usage;
}

export interface CompletionRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
}

export interface Provider {
  readonly id: string;
  complete(req: CompletionRequest): Promise<Completion>;
}

export type ProviderErrorKind = "auth" | "rate_limit" | "overloaded" | "bad_request" | "unknown";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
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

export function errorKindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "overloaded";
  if (status >= 400) return "bad_request";
  return "unknown";
}
