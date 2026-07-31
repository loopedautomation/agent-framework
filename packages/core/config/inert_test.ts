import { assertEquals } from "@std/assert";
import { parseAgentConfig } from "./load.ts";
import { inertDeclarations } from "./inert.ts";

/** An agent file with a priced model, so only the block under test is inert. */
function config(extra: string) {
  return parseAgentConfig(`
handle: inert-bot
description: inert declaration test agent
model:
  provider: anthropic
  id: claude-opus-5
purpose: You do a job.
${extra}`);
}

const kinds = (extra: string) => inertDeclarations(config(extra)).map((d) => d.kind);

Deno.test("a well-formed agent declares nothing inert", () => {
  assertEquals(
    kinds(`permissions:
  net: ["api.github.com", "*.example.com", "*"]
memory:
  scope: thread
  compact_at_tokens: 100000
http:
  auth:
    - url: https://api.github.com
      value: Bearer \${GH_TOKEN}`),
    [],
  );
});

Deno.test("a credential for a host the agent cannot reach is named", () => {
  const found = inertDeclarations(config(`permissions:
  net: ["api.github.com"]
http:
  auth:
    - url: https://api.stripe.com/v1
      value: Bearer \${STRIPE_KEY}`));
  assertEquals(found.length, 1);
  assertEquals(found[0].kind, "credential_unreachable");
  assertEquals(found[0].where, "http.auth[0].url");
  assertEquals(found[0].advice.includes("api.stripe.com"), true);
});

Deno.test("a wildcard net entry covers a credential's host", () => {
  assertEquals(
    kinds(`permissions:
  net: ["*.stripe.com"]
http:
  auth:
    - url: https://api.stripe.com
      value: Bearer \${K}`),
    [],
  );
  // The apex is not a subdomain, here as everywhere else.
  assertEquals(
    kinds(`permissions:
  net: ["*.stripe.com"]
http:
  auth:
    - url: https://stripe.com
      value: Bearer \${K}`),
    ["credential_unreachable"],
  );
});

Deno.test("a net entry that is not a bare host will never match", () => {
  assertEquals(
    kinds(`permissions:
  net: ["https://api.github.com"]`),
    ["net_not_a_host"],
  );
  assertEquals(
    kinds(`permissions:
  net: ["api.github.com/repos"]`),
    ["net_not_a_host"],
  );
  assertEquals(
    kinds(`permissions:
  net: ["api.github.com:443"]`),
    ["net_not_a_host"],
  );
  assertEquals(
    kinds(`permissions:
  net: ["user@api.github.com"]`),
    ["net_not_a_host"],
  );
  // A bare host, a wildcard and a bracketed IPv6 literal are all fine.
  assertEquals(
    kinds(`permissions:
  net: ["api.github.com", "*.example.com", "*", "[::1]"]`),
    [],
  );
});

Deno.test("the scheme advice names the host to use instead", () => {
  const found = inertDeclarations(config(`permissions:
  net: ["https://api.github.com/repos"]`));
  assertEquals(found[0].advice.includes('use "api.github.com"'), true);
});

Deno.test("a compaction threshold without thread scope has nothing to compact", () => {
  assertEquals(
    kinds(`memory:
  scope: none
  compact_at_tokens: 100000`),
    ["compaction_without_history"],
  );
  // false is an author saying they do not want it, which is not a mistake.
  assertEquals(
    kinds(`memory:
  scope: none
  compact_at_tokens: false`),
    [],
  );
  assertEquals(
    kinds(`memory:
  scope: thread
  compact_at_tokens: 100000`),
    [],
  );
});

Deno.test("a spend cap on an unpriced model cannot fire", () => {
  const unpriced = parseAgentConfig(`
handle: inert-bot
description: inert declaration test agent
model:
  provider: openai-compatible
  id: some-local-model
purpose: You do a job.
`);
  assertEquals(inertDeclarations(unpriced).map((d) => d.kind), ["cost_cap_without_price"]);

  // Declaring the price fixes it.
  const priced = parseAgentConfig(`
handle: inert-bot
description: inert declaration test agent
model:
  provider: openai-compatible
  id: some-local-model
  pricing:
    input_per_mtok: 0.5
    output_per_mtok: 1.5
purpose: You do a job.
`);
  assertEquals(inertDeclarations(priced), []);

  // So does saying you do not want a cap.
  const uncapped = parseAgentConfig(`
handle: inert-bot
description: inert declaration test agent
model:
  provider: openai-compatible
  id: some-local-model
purpose: You do a job.
limits:
  max_cost: 0
`);
  assertEquals(inertDeclarations(uncapped), []);
});

Deno.test("every inert declaration says where it is and what to do", () => {
  const found = inertDeclarations(config(`permissions:
  net: ["https://api.github.com"]
memory:
  scope: none
  compact_at_tokens: 50000
http:
  auth:
    - url: https://api.stripe.com
      value: Bearer \${K}`));
  assertEquals(found.length, 3);
  for (const d of found) {
    assertEquals(d.where.length > 0, true);
    // Naming the problem without naming the fix would leave the reader stuck.
    assertEquals(/Add |use |Set |remove |drop /.test(d.advice), true);
  }
});
