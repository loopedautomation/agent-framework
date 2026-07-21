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
import { redactText } from "../redact/redact.ts";
import { withRetry } from "./retry.ts";

export interface GeminiOptions {
  apiKey: string;
  /** Defaults to the Gemini API; point at a proxy or regional endpoint. */
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

type WirePart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { id?: string; name: string; args: unknown } }
  | { functionResponse: { id?: string; name: string; response: { result: string } } };

interface WireContent {
  role: "user" | "model";
  parts: WirePart[];
}

// Gemini matches tool results to calls by function name, not id, and only
// some model versions emit an id at all. Synthesized ids carry the name so
// the tool-result turn can recover it: "<name>#<counter>".
function toolNameFromId(id: string): string {
  const hash = id.lastIndexOf("#");
  return hash === -1 ? id : id.slice(0, hash);
}

/**
 * Gemini's dialect has two roles (user/model): tool results are
 * functionResponse parts in a user turn, and consecutive same-role
 * turns must be merged.
 */
function toWireContents(messages: Message[]): WireContent[] {
  const wire: WireContent[] = [];
  const push = (role: "user" | "model", part: WirePart) => {
    const last = wire.at(-1);
    if (last?.role === role) last.parts.push(part);
    else wire.push({ role, parts: [part] });
  };
  for (const m of messages) {
    switch (m.role) {
      case "user":
        // Images before the text, the order the user sent them in.
        for (const image of m.images ?? []) {
          push("user", { inlineData: { mimeType: image.mediaType, data: image.data } });
        }
        push("user", { text: m.content });
        break;
      case "assistant":
        if (m.content) push("model", { text: m.content });
        for (const tc of m.toolCalls ?? []) {
          push("model", {
            functionCall: { id: tc.id, name: tc.name, args: JSON.parse(tc.arguments || "{}") },
          });
        }
        break;
      case "tool":
        push("user", {
          functionResponse: {
            id: m.toolCallId,
            name: toolNameFromId(m.toolCallId),
            response: { result: m.content },
          },
        });
        break;
    }
  }
  return wire;
}

/** Provider adapter for the native Gemini API (generateContent). */
export class GeminiProvider implements Provider {
  /** Provider identifier. */
  readonly id = "gemini";
  #apiKey: string;
  #baseUrl: string;
  #fetch: typeof fetch;
  #callCounter = 0;

  /** Create the provider from an API key, optional base URL, and an injectable fetch for tests. */
  constructor(opts: GeminiOptions) {
    this.#apiKey = opts.apiKey;
    this.#baseUrl = (opts.baseUrl ?? "https://generativelanguage.googleapis.com").replace(
      /\/$/,
      "",
    );
    this.#fetch = opts.fetch ?? fetch;
  }

  /** Run one completion, with retry on retryable provider errors. */
  complete(req: CompletionRequest): Promise<Completion> {
    return withRetry(() => this.#completeOnce(req));
  }

  async #completeOnce(req: CompletionRequest): Promise<Completion> {
    const body = {
      systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
      contents: toWireContents(req.messages),
      tools: req.tools?.length
        ? [{
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        }]
        : undefined,
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? 4096,
        temperature: req.temperature,
      },
    };

    let res: Response;
    try {
      res = await this.#fetch(
        `${this.#baseUrl}/v1beta/models/${req.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.#apiKey,
          },
          body: JSON.stringify(body),
        },
      );
    } catch (err) {
      throw new ProviderError(`request failed: ${(err as Error).message}`, "overloaded");
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `provider returned ${res.status}: ${redactText(text.slice(0, 300))}`,
        errorKindForStatus(res.status),
        res.status,
      );
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const parts: WirePart[] = candidate?.content?.parts ?? [];
    const content = parts
      .filter((p): p is Extract<WirePart, { text: string }> => "text" in p)
      .map((p) => p.text)
      .join("");
    const toolCalls: ToolCall[] = parts
      .filter((p): p is Extract<WirePart, { functionCall: unknown }> => "functionCall" in p)
      .map((p) => ({
        id: p.functionCall.id ?? `${p.functionCall.name}#${this.#callCounter++}`,
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args ?? {}),
      }));

    // Gemini has no tool_calls finish reason: a STOP turn with functionCall
    // parts is a tool request.
    const stopReason: StopReason = toolCalls.length
      ? "tool_calls"
      : candidate?.finishReason === "MAX_TOKENS"
      ? "max_tokens"
      : "end";

    return {
      content,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        // thoughtsTokenCount is billed as output but reported separately.
        outputTokens: (data.usageMetadata?.candidatesTokenCount ?? 0) +
          (data.usageMetadata?.thoughtsTokenCount ?? 0),
      },
    };
  }
}
