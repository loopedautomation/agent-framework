import { DEFAULT_API_KEY_ENV, type ModelConfig } from "../config/schema.ts";
import { type Provider, ProviderError } from "./types.ts";
import { OpenAICompatibleProvider } from "./openai.ts";
import { AnthropicProvider } from "./anthropic.ts";

export * from "./types.ts";
export { OpenAICompatibleProvider } from "./openai.ts";
export { AnthropicProvider } from "./anthropic.ts";
export { withRetry } from "./retry.ts";

/**
 * Build a provider from config. The API key is read from the env var named
 * by `api_key_env` (or the provider's conventional default). A missing key
 * is tolerated only for openai-compatible endpoints with an explicit
 * base_url (local models often need none).
 */
export function createProvider(
  model: ModelConfig,
  getEnv: (name: string) => string | undefined = Deno.env.get,
): Provider {
  const keyEnv = model.api_key_env ?? DEFAULT_API_KEY_ENV[model.provider];
  const apiKey = getEnv(keyEnv);
  if (!apiKey && !(model.provider === "openai-compatible" && model.base_url)) {
    throw new ProviderError(
      `missing API key: set ${keyEnv} (or point model.api_key_env at the right env var)`,
      "auth",
    );
  }
  switch (model.provider) {
    case "openai-compatible":
      return new OpenAICompatibleProvider({ apiKey: apiKey ?? "", baseUrl: model.base_url });
    case "anthropic":
      return new AnthropicProvider({ apiKey: apiKey!, baseUrl: model.base_url });
  }
}
