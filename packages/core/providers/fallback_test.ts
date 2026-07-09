import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert";
import { type ModelConfig, resolveFallbackModel } from "../config/schema.ts";
import { createFallbackChain, FallbackProvider } from "./fallback.ts";
import { type Completion, type CompletionRequest, type Provider, ProviderError } from "./types.ts";

const completion = (content: string): Completion => ({
  content,
  toolCalls: [],
  stopReason: "end",
  usage: { inputTokens: 0, outputTokens: 0 },
});

/** A stub Provider recording the models it was asked for; scripted to succeed or throw. */
function stub(
  id: string,
  behavior: (req: CompletionRequest) => Completion | Error,
): Provider & { models: string[] } {
  const models: string[] = [];
  return {
    id,
    models,
    complete(req: CompletionRequest): Promise<Completion> {
      models.push(req.model);
      const out = behavior(req);
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    },
  };
}

const req: CompletionRequest = { model: "primary", messages: [{ role: "user", content: "hi" }] };

Deno.test("FallbackProvider: first success skips the fallbacks", async () => {
  const a = stub("a", () => completion("from-a"));
  const b = stub("b", () => new ProviderError("down", "overloaded"));
  const chain = new FallbackProvider([
    { provider: a, model: "model-a" },
    { provider: b, model: "model-b" },
  ]);

  const out = await chain.complete(req);
  assertEquals(out.content, "from-a");
  assertEquals(a.models, ["model-a"]); // req.model overridden per attempt
  assertEquals(b.models, []); // never reached
  assertEquals(chain.id, "a"); // reports the primary's id
});

Deno.test("FallbackProvider: advances past a ProviderError to the next attempt", async () => {
  const a = stub("a", () => new ProviderError("rate limited", "rate_limit"));
  const b = stub("b", () => completion("from-b"));
  const chain = new FallbackProvider([
    { provider: a, model: "model-a" },
    { provider: b, model: "model-b" },
  ]);

  const out = await chain.complete(req);
  assertEquals(out.content, "from-b");
  assertEquals(a.models, ["model-a"]);
  assertEquals(b.models, ["model-b"]);
});

Deno.test("FallbackProvider: all failing rethrows the last ProviderError", async () => {
  const a = stub("a", () => new ProviderError("first", "overloaded"));
  const b = stub("b", () => new ProviderError("last", "auth"));
  const chain = new FallbackProvider([
    { provider: a, model: "model-a" },
    { provider: b, model: "model-b" },
  ]);

  const err = await assertRejects(() => chain.complete(req), ProviderError, "last");
  assertEquals(err.kind, "auth");
});

Deno.test("FallbackProvider: a non-ProviderError propagates without advancing", async () => {
  const a = stub("a", () => new TypeError("bug"));
  const b = stub("b", () => completion("from-b"));
  const chain = new FallbackProvider([
    { provider: a, model: "model-a" },
    { provider: b, model: "model-b" },
  ]);

  await assertRejects(() => chain.complete(req), TypeError, "bug");
  assertEquals(b.models, []); // did not fall through a real bug
});

Deno.test("createFallbackChain: no fallbacks returns a plain provider", () => {
  const model: ModelConfig = { provider: "anthropic", id: "claude-sonnet-5" };
  const provider = createFallbackChain(model, () => "key");
  assertEquals(provider instanceof FallbackProvider, false);
  assertEquals(provider.id, "anthropic");
});

Deno.test("createFallbackChain: builds a chain and fails fast on a fallback's missing key", () => {
  const model: ModelConfig = {
    provider: "anthropic",
    id: "claude-sonnet-5",
    fallbacks: [{ provider: "openai-compatible", id: "gpt-5.4-mini" }],
  };
  // Primary key present, fallback (OPENAI_API_KEY) absent → throws at build time.
  const env: Record<string, string> = { ANTHROPIC_API_KEY: "k" };
  assertThrows(
    () => createFallbackChain(model, (n) => env[n]),
    ProviderError,
    "missing API key",
  );

  env.OPENAI_API_KEY = "k2";
  const chain = createFallbackChain(model, (n) => env[n]);
  assertStrictEquals(chain instanceof FallbackProvider, true);
});

Deno.test("resolveFallbackModel: string is a model id on the primary's provider", () => {
  const primary: ModelConfig = {
    provider: "anthropic",
    id: "claude-sonnet-5",
    base_url: "https://proxy.example",
    api_key_env: "MY_KEY",
  };
  assertEquals(resolveFallbackModel(primary, "claude-haiku-5"), {
    provider: "anthropic",
    id: "claude-haiku-5",
    base_url: "https://proxy.example",
    api_key_env: "MY_KEY",
  });
});

Deno.test("resolveFallbackModel: object overrides win, unspecified fields inherit", () => {
  const primary: ModelConfig = { provider: "anthropic", id: "claude-sonnet-5" };
  assertEquals(
    resolveFallbackModel(primary, {
      provider: "openai-compatible",
      id: "gpt-5.4-mini",
      api_key_env: "OPENAI_API_KEY",
    }),
    {
      provider: "openai-compatible",
      id: "gpt-5.4-mini",
      base_url: undefined,
      api_key_env: "OPENAI_API_KEY",
    },
  );
});
