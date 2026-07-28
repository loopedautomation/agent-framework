import { DEFAULT_API_KEY_ENV, type ModelConfig } from "../config/schema.ts";
import { type Provider, ProviderError } from "./types.ts";
import { OpenAICompatibleProvider } from "./openai.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { CodexProvider } from "./codex.ts";
import { GeminiProvider } from "./gemini.ts";

export * from "./types.ts";
export { OpenAICompatibleProvider } from "./openai.ts";
export { AnthropicProvider } from "./anthropic.ts";
export { CodexProvider } from "./codex.ts";
export { GeminiProvider } from "./gemini.ts";
export { type RetryOptions, withRetry } from "./retry.ts";

/**
 * Build a provider from config. The API key is read from the env var named
 * by `api_key_env` (or the provider's conventional default). A missing key
 * is tolerated only for openai-compatible endpoints with an explicit
 * base_url (local models often need none). The codex provider takes no key
 * at all: it authenticates with the OAuth credentials the Codex CLI stores
 * under CODEX_HOME (default ~/.codex), with the same JSON pasted into
 * CODEX_AUTH_JSON for file-less deploys, or with a Business/Enterprise
 * machine token in CODEX_ACCESS_TOKEN (which wins over both). The anthropic
 * provider additionally accepts a Claude subscription OAuth token (from
 * `claude setup-token`), read from the key env var or CLAUDE_CODE_OAUTH_TOKEN.
 */
export function createProvider(
  model: ModelConfig,
  getEnv: (name: string) => string | undefined = Deno.env.get,
): Provider {
  if (model.provider === "codex") {
    const home = getEnv("CODEX_HOME") ?? `${getEnv("HOME") ?? "."}/.codex`;
    return new CodexProvider({
      authFile: `${home}/auth.json`,
      authJson: getEnv("CODEX_AUTH_JSON"),
      accessToken: getEnv("CODEX_ACCESS_TOKEN"),
      baseUrl: model.base_url,
    });
  }
  const keyEnv = model.api_key_env ?? DEFAULT_API_KEY_ENV[model.provider];
  let apiKey = getEnv(keyEnv);
  // Claude subscription auth: an OAuth token from `claude setup-token` can
  // stand in for an API key. CLAUDE_CODE_OAUTH_TOKEN is the conventional env
  // var; the adapter switches to Bearer auth when it sees the oat prefix.
  if (!apiKey && model.provider === "anthropic" && !model.api_key_env) {
    apiKey = getEnv("CLAUDE_CODE_OAUTH_TOKEN");
  }
  if (!apiKey && !(model.provider === "openai-compatible" && model.base_url)) {
    const hint = model.provider === "anthropic" ? ` or CLAUDE_CODE_OAUTH_TOKEN` : "";
    throw new ProviderError(
      `missing API key: set ${keyEnv}${hint} (or point model.api_key_env at the right env var)`,
      "auth",
    );
  }
  switch (model.provider) {
    case "openai-compatible":
      return new OpenAICompatibleProvider({ apiKey: apiKey ?? "", baseUrl: model.base_url });
    case "anthropic":
      return new AnthropicProvider({ apiKey: apiKey!, baseUrl: model.base_url });
    case "gemini":
      return new GeminiProvider({ apiKey: apiKey!, baseUrl: model.base_url });
  }
}
