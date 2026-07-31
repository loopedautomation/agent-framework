import { assertEquals } from "@std/assert";
import { costOf, formatCost, priceFor } from "./pricing.ts";

Deno.test("priceFor matches exactly, then by longest prefix", () => {
  assertEquals(priceFor("claude-opus-5")?.inputPerMTok, 5);
  // A dated snapshot inherits its family's price rather than needing a row.
  assertEquals(priceFor("claude-sonnet-5-20260115")?.outputPerMTok, 15);
  // "claude-opus-4-8" must win over any shorter key that also prefixes it.
  assertEquals(priceFor("claude-opus-4-8-20260301")?.inputPerMTok, 5);
  // An unknown model is undefined, never a zero that would read as free.
  assertEquals(priceFor("llama-3-70b"), undefined);
  assertEquals(priceFor(""), undefined);
});

Deno.test("costOf prices a run in dollars per million tokens", () => {
  const price = { inputPerMTok: 5, outputPerMTok: 25 };
  assertEquals(costOf({ inputTokens: 1_000_000, outputTokens: 0 }, price), 5);
  assertEquals(costOf({ inputTokens: 0, outputTokens: 1_000_000 }, price), 25);
  assertEquals(costOf({ inputTokens: 200_000, outputTokens: 40_000 }, price), 2);
  assertEquals(costOf({ inputTokens: 0, outputTokens: 0 }, price), 0);
});

Deno.test("formatCost keeps small amounts legible", () => {
  assertEquals(formatCost(0.02431), "$0.0243");
  assertEquals(formatCost(12.4), "$12.40");
  assertEquals(formatCost(1), "$1.00");
});
