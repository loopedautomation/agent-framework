import { ProviderError } from "./types.ts";

/** Tuning for {@linkcode withRetry}. */
export interface RetryOptions {
  /** Total attempts including the first. Defaults to 3. */
  attempts?: number;
  /** Backoff base; delay is base * 2^attempt. Defaults to 500. */
  baseDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry retryable provider errors with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = err instanceof ProviderError && err.retryable;
      if (!retryable || attempt === attempts - 1) throw err;
      await sleep(base * 2 ** attempt);
    }
  }
  throw lastError;
}
