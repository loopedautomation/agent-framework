import type { Usage } from "./types.ts";

/**
 * What one model charges, in US dollars per million tokens. The unit is
 * per-million because that is how every provider publishes it: copying a
 * number off a pricing page should not need arithmetic.
 */
export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

/**
 * Published list prices, keyed by the model id an agent file would write.
 *
 * This table is a convenience, not a contract. Prices change, discounts and
 * committed-use rates are not visible from here, and a proxy in front of an
 * openai-compatible endpoint may charge something else entirely. An agent that
 * needs the number to be right sets `model.pricing` and stops depending on
 * this list.
 *
 * Keys are matched exactly first, then by longest matching prefix, so a dated
 * snapshot (`claude-sonnet-5-20260115`) inherits its family's price without
 * needing its own row.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * Look up a price by model id: exact match, then the longest key that is a
 * prefix of the id, so dated snapshots inherit their family's price.
 * Undefined when nothing matches, which callers must handle rather than
 * treating as free.
 */
export function priceFor(modelId: string): ModelPrice | undefined {
  const exact = MODEL_PRICES[modelId];
  if (exact) return exact;
  let best: string | undefined;
  for (const key of Object.keys(MODEL_PRICES)) {
    if (modelId.startsWith(key) && (best === undefined || key.length > best.length)) best = key;
  }
  return best ? MODEL_PRICES[best] : undefined;
}

/** What this usage cost at this price, in US dollars. */
export function costOf(usage: Usage, price: ModelPrice): number {
  return (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) /
    1_000_000;
}

/** Render a dollar amount for a reply or a log line: `$0.0243`, `$12.40`. */
export function formatCost(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}
