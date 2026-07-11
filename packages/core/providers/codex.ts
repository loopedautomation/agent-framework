import {
  type Completion,
  type CompletionRequest,
  errorKindForStatus,
  type Message,
  type Provider,
  ProviderError,
  type StopReason,
  type ToolCall,
  type ToolDef,
} from "./types.ts";
import { redactText } from "../redact/redact.ts";
import { withRetry } from "./retry.ts";

// The OAuth client id the Codex CLI registers with auth.openai.com; token
// refresh must present the same client the tokens were issued to.
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
// Refresh when the access token has less than this long to live.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface CodexOptions {
  /** Path to the Codex CLI credential file (auth.json from `codex login`). */
  authFile: string;
  /**
   * Inline auth.json contents (the CODEX_AUTH_JSON env var). Takes precedence
   * over authFile; refreshed tokens then live only in process memory.
   */
  authJson?: string;
  /**
   * A Codex access token (the CODEX_ACCESS_TOKEN env var) — the machine
   * tokens ChatGPT Business/Enterprise admins mint for automation. A static
   * credential: no refresh, no file. Takes precedence over everything else.
   */
  accessToken?: string;
  /** Defaults to the ChatGPT Codex backend. */
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

interface CodexTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id?: string;
}

interface CodexAuthFile {
  tokens?: CodexTokens;
  last_refresh?: string;
  [key: string]: unknown;
}

/** Decode a JWT payload without verifying — we only read exp and account id. */
function jwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return undefined;
  }
}

function accountId(tokens: CodexTokens): string | undefined {
  if (tokens.account_id) return tokens.account_id;
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue;
    const auth = jwtPayload(token)?.["https://api.openai.com/auth"] as
      | { chatgpt_account_id?: string }
      | undefined;
    if (auth?.chatgpt_account_id) return auth.chatgpt_account_id;
  }
  return undefined;
}

/** Responses-API input items (the dialect the Codex backend speaks). */
type InputItem =
  | {
    type: "message";
    role: "user" | "assistant";
    content: { type: "input_text" | "output_text"; text: string }[];
  }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

function toInputItems(messages: Message[]): InputItem[] {
  const items: InputItem[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "user":
        items.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: m.content }],
        });
        break;
      case "assistant":
        if (m.content) {
          items.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: m.content }],
          });
        }
        for (const tc of m.toolCalls ?? []) {
          items.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
        }
        break;
      case "tool":
        items.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
        break;
    }
  }
  return items;
}

interface WireOutputItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
}

interface WireResponse {
  status?: string;
  incomplete_details?: { reason?: string };
  output?: WireOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface FinalEvent {
  response: WireResponse;
  /**
   * Text accumulated from `response.output_text.delta` events, in stream
   * order. Some accounts/models return a `response.completed` whose
   * `output` array is empty even though the model answered — the answer
   * only ever appears in the incremental delta events. Used as a last-resort
   * fallback when neither `response.output` nor `reconstructedOutput` yields
   * any text.
   */
  streamedText: string;
  /**
   * Output items rebuilt from `response.output_item.done` events (each
   * carries the fully finalized item — message or function_call — as
   * `event.item`), ordered by `output_index`. The same broken-account bug
   * that empties `response.output` can also drop function_call items, and
   * those have no text delta to fall back on, so this is the fallback for
   * tool calls (and a secondary fallback for text).
   */
  reconstructedOutput: WireOutputItem[];
}

/**
 * Walk an SSE stream and pull out the terminal `response.completed` payload,
 * plus everything needed to reconstruct output when that payload's `output`
 * array is empty (see FinalEvent for why that happens).
 */
function finalEvent(sse: string): FinalEvent {
  let completed: WireResponse | undefined;
  let streamedText = "";
  const itemsByIndex = new Map<number, WireOutputItem>();
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: {
      type?: string;
      response?: WireResponse;
      delta?: string;
      output_index?: number;
      item?: WireOutputItem;
    };
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (event.type === "response.failed") {
      const reason = (event.response as { error?: { message?: string } } | undefined)?.error
        ?.message;
      throw new ProviderError(`codex response failed: ${reason ?? "unknown"}`, "unknown");
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      streamedText += event.delta;
    }
    if (
      event.type === "response.output_item.done" && event.item &&
      typeof event.output_index === "number"
    ) {
      itemsByIndex.set(event.output_index, event.item);
    }
    if (event.type === "response.completed" && event.response) completed = event.response;
  }
  if (!completed) {
    throw new ProviderError("codex stream ended without response.completed", "unknown");
  }
  const reconstructedOutput = [...itemsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, item]) => item);
  return { response: completed, streamedText, reconstructedOutput };
}

/** Extract text content and tool calls from a list of Responses API output items. */
function extractOutput(items: WireOutputItem[]): { content: string; toolCalls: ToolCall[] } {
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const item of items) {
    if (item.type === "message") {
      for (const block of item.content ?? []) {
        if (block.type === "output_text" && block.text) content += block.text;
      }
    } else if (item.type === "function_call" && item.call_id && item.name) {
      toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments ?? "{}" });
    }
  }
  return { content, toolCalls };
}

/**
 * Provider adapter for OpenAI Codex via a ChatGPT subscription. Authenticates
 * with the OAuth tokens the Codex CLI writes to auth.json (`codex login`),
 * refreshing them when they near expiry — no API key involved.
 */
export class CodexProvider implements Provider {
  /** Provider identifier. */
  readonly id = "codex";
  #authFile: string;
  #authJson?: string;
  #accessToken?: string;
  #baseUrl: string;
  #fetch: typeof fetch;
  #tokens?: CodexTokens;
  #refreshing?: Promise<CodexTokens>;

  /** Create the provider from a credential-file path and an injectable fetch for tests. */
  constructor(opts: CodexOptions) {
    this.#authFile = opts.authFile;
    this.#authJson = opts.authJson;
    this.#accessToken = opts.accessToken;
    this.#baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#fetch = opts.fetch ?? fetch;
  }

  /** Run one completion, with retry on retryable provider errors. */
  complete(req: CompletionRequest): Promise<Completion> {
    return withRetry(() => this.#completeOnce(req));
  }

  async #readAuthFile(): Promise<CodexAuthFile> {
    if (this.#authJson !== undefined) {
      try {
        return JSON.parse(this.#authJson);
      } catch {
        throw new ProviderError(
          "CODEX_AUTH_JSON is not valid JSON — paste the full contents of the auth.json written by `codex login`",
          "auth",
        );
      }
    }
    let raw: string;
    try {
      raw = await Deno.readTextFile(this.#authFile);
    } catch (err) {
      throw new ProviderError(
        `cannot read codex credentials at ${this.#authFile}: ${
          (err as Error).message
        } — run \`codex login\` (or mount the file into the container)`,
        "auth",
      );
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new ProviderError(`codex credential file ${this.#authFile} is not valid JSON`, "auth");
    }
  }

  async #accessTokens(): Promise<CodexTokens> {
    // A machine token is static: nothing to read, refresh, or persist. An
    // expired one surfaces as a 401 auth error; mint a new token to fix it.
    if (this.#accessToken) {
      return { access_token: this.#accessToken, refresh_token: "" };
    }
    if (!this.#tokens) {
      const file = await this.#readAuthFile();
      if (!file.tokens?.access_token || !file.tokens.refresh_token) {
        throw new ProviderError(
          `codex credential file ${this.#authFile} has no OAuth tokens — run \`codex login\` (API-key logins should use the openai-compatible provider instead)`,
          "auth",
        );
      }
      this.#tokens = file.tokens;
    }
    const exp = jwtPayload(this.#tokens.access_token)?.exp;
    if (typeof exp === "number" && exp * 1000 - Date.now() < EXPIRY_MARGIN_MS) {
      // Single-flight: concurrent completions share one refresh.
      this.#refreshing ??= this.#refresh(this.#tokens).finally(() => {
        this.#refreshing = undefined;
      });
      this.#tokens = await this.#refreshing;
    }
    return this.#tokens;
  }

  async #refresh(tokens: CodexTokens): Promise<CodexTokens> {
    let res: Response;
    try {
      res = await this.#fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          scope: "openid profile email",
        }),
      });
    } catch (err) {
      throw new ProviderError(
        `codex token refresh failed: ${(err as Error).message}`,
        "overloaded",
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `codex token refresh returned ${res.status}: ${
          redactText(text.slice(0, 300))
        } — run \`codex login\` again`,
        res.status === 429 || res.status >= 500 ? errorKindForStatus(res.status) : "auth",
        res.status,
      );
    }
    const data = await res.json();
    const next: CodexTokens = {
      ...tokens,
      access_token: data.access_token ?? tokens.access_token,
      refresh_token: data.refresh_token ?? tokens.refresh_token,
      id_token: data.id_token ?? tokens.id_token,
    };
    // Persist so restarts (and the Codex CLI) see the fresh tokens. Best
    // effort: a read-only mount just means we refresh again next boot.
    // Inline env credentials have no file to write back to.
    if (this.#authJson !== undefined) return next;
    try {
      const file = await this.#readAuthFile();
      file.tokens = { ...(file.tokens ?? {}), ...next };
      file.last_refresh = new Date().toISOString();
      await Deno.writeTextFile(this.#authFile, JSON.stringify(file, null, 2));
    } catch {
      // ignore: refreshed tokens still live in memory for this process
    }
    return next;
  }

  async #completeOnce(req: CompletionRequest): Promise<Completion> {
    const tokens = await this.#accessTokens();
    const account = accountId(tokens);
    // OAuth credentials always embed the account id; machine tokens may not,
    // and the backend resolves their workspace identity from the token alone.
    if (!account && !this.#accessToken) {
      throw new ProviderError(
        "codex credentials carry no ChatGPT account id — run `codex login` again",
        "auth",
      );
    }

    // The Codex backend rejects sampling parameters and requires streaming;
    // maxTokens/temperature are intentionally not forwarded.
    const body = {
      model: req.model,
      instructions: req.system ?? "You are a helpful assistant.",
      input: toInputItems(req.messages),
      tools: req.tools?.length ? req.tools.map(toWireTool) : undefined,
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      stream: true,
    };

    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${tokens.access_token}`,
          ...(account ? { "chatgpt-account-id": account } : {}),
          "openai-beta": "responses=experimental",
          originator: "codex_cli_rs",
          session_id: crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderError(`request failed: ${(err as Error).message}`, "overloaded");
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // A stale access token surfaces as 401; drop the cache so the next
      // attempt re-reads the file and refreshes.
      if (res.status === 401) this.#tokens = undefined;
      throw new ProviderError(
        `provider returned ${res.status}: ${redactText(text.slice(0, 300))}`,
        errorKindForStatus(res.status),
        res.status,
      );
    }

    const { response, streamedText, reconstructedOutput } = finalEvent(await res.text());

    let { content, toolCalls } = extractOutput(response.output ?? []);
    // response.completed.output is empty for some accounts even when the
    // model answered (with content or a tool call) — fall back to items
    // rebuilt from response.output_item.done, and finally to raw streamed
    // text if even that reconstruction comes up empty.
    if (!content && toolCalls.length === 0) {
      ({ content, toolCalls } = extractOutput(reconstructedOutput));
    }
    if (!content && toolCalls.length === 0) content = streamedText;

    return {
      content,
      toolCalls,
      stopReason: toStopReason(response, toolCalls),
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }
}

function toWireTool(t: ToolDef): Record<string, unknown> {
  return {
    type: "function",
    name: t.name,
    description: t.description,
    strict: false,
    parameters: t.inputSchema,
  };
}

function toStopReason(response: WireResponse, toolCalls: ToolCall[]): StopReason {
  if (toolCalls.length > 0) return "tool_calls";
  if (
    response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens"
  ) return "max_tokens";
  return "end";
}
