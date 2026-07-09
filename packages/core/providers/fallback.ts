import { type ModelConfig, resolveFallbackModel } from "../config/schema.ts";
import { createProvider } from "./mod.ts";
import { type Completion, type CompletionRequest, type Provider, ProviderError } from "./types.ts";

/** One link in a fallback chain: a backend and the model id to call it with. */
export interface FallbackAttempt {
  /** The backend to call. */
  provider: Provider;
  /** Model id to request from this backend, overriding the caller's `req.model`. */
  model: string;
}

/**
 * A Provider that tries an ordered list of backends, advancing to the next on
 * any {@linkcode ProviderError} (a backend's own transient retries are already
 * exhausted by then). The caller's `req.model` is overridden with each
 * attempt's model id, so one chain can span models and providers. If every
 * attempt fails the last ProviderError is rethrown; a non-ProviderError is a
 * bug and propagates immediately without advancing.
 */
export class FallbackProvider implements Provider {
  readonly id: string;
  #attempts: FallbackAttempt[];

  /** Build from a non-empty ordered list of attempts; the first is the primary. */
  constructor(attempts: FallbackAttempt[]) {
    if (attempts.length === 0) throw new Error("FallbackProvider needs at least one attempt");
    this.#attempts = attempts;
    this.id = attempts[0].provider.id;
  }

  /** Try each backend in order; return the first success, else rethrow the last ProviderError. */
  async complete(req: CompletionRequest): Promise<Completion> {
    let lastError: ProviderError | undefined;
    for (const attempt of this.#attempts) {
      try {
        return await attempt.provider.complete({ ...req, model: attempt.model });
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }
}

/**
 * Build the provider used for the agent loop. With no `fallbacks` this is a
 * plain {@linkcode createProvider} of the primary (zero overhead); otherwise a
 * {@linkcode FallbackProvider} over the primary plus each resolved fallback.
 * Every backend is constructed here, so a fallback with a missing API key fails
 * at startup rather than mid-run.
 */
export function createFallbackChain(
  model: ModelConfig,
  getEnv: (name: string) => string | undefined = Deno.env.get,
): Provider {
  const primary = createProvider(model, getEnv);
  if (!model.fallbacks?.length) return primary;
  const attempts: FallbackAttempt[] = [{ provider: primary, model: model.id }];
  for (const entry of model.fallbacks) {
    const resolved = resolveFallbackModel(model, entry);
    attempts.push({ provider: createProvider(resolved, getEnv), model: resolved.id });
  }
  return new FallbackProvider(attempts);
}
