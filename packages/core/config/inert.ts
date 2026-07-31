import type { AgentConfig } from "./schema.ts";
import { priceFor } from "../providers/pricing.ts";

/**
 * Declarations that are loaded, well-formed, and have no effect.
 *
 * This is a different failure from a grant that is wider than it looks
 * (`runGrantAdvisories`, ../permissions/advisories.ts). Those are real
 * authority stated imprecisely. These are statements the runtime will never
 * act on: a credential attached to a host the agent cannot reach, a
 * compaction threshold on an agent with no history to compact, a spend cap on
 * a model with no known price.
 *
 * The failure mode is what makes them worth naming. An author who writes one
 * of these believes they configured something, and nothing contradicts them:
 * no error, no warning, no behaviour. A security control in that state is the
 * worst kind, because the operator's mental model is wrong and stays wrong.
 * The rule this enforces is that every declaration either takes effect or says
 * out loud that it did not.
 *
 * These never refuse a config. An inert declaration is harmless in itself; it
 * is the belief about it that costs something, and printing it is enough to
 * fix that.
 */

/** Which declaration is inert. */
export type InertKind =
  /** An `http.auth` credential whose host is not in `permissions.net`. */
  | "credential_unreachable"
  /** A `permissions.net` entry that is not a bare host, so it matches nothing. */
  | "net_not_a_host"
  /** `memory.compact_at_tokens` without `memory.scope: thread`. */
  | "compaction_without_history"
  /** `limits.max_cost` with no price for the model. */
  | "cost_cap_without_price";

/** One declaration that will not do anything. */
export interface InertDeclaration {
  /** Which kind of no-op this is. */
  kind: InertKind;
  /** Dotted path to the declaration, e.g. `http.auth[0].url`. */
  where: string;
  /** One printable line: what is inert, and what to do about it. */
  advice: string;
}

/** The host part of a URL prefix, or undefined when it does not parse. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Same rule as the permission engine: `*.example.com` matches subdomains, not the apex. */
function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host !== pattern.slice(2);
  return pattern === host;
}

/**
 * A `permissions.net` entry is a hostname or a `*.` wildcard. Anything
 * carrying a scheme, a path, a port or a userinfo section is compared against
 * a bare hostname at runtime and can never match, which is a common enough
 * mistake to be worth naming: `https://api.github.com` looks right and denies
 * everything.
 */
function netEntryProblem(entry: string): string | undefined {
  if (entry === "*") return undefined;
  if (entry.includes("://")) return "it has a scheme";
  if (entry.includes("/")) return "it has a path";
  if (entry.includes("@")) return "it has a userinfo section";
  // A bracketed IPv6 literal is a legitimate host; a trailing :port is not.
  if (!entry.startsWith("[") && /:\d+$/.test(entry)) return "it has a port";
  return undefined;
}

/** Every declaration in `config` that the runtime will never act on. */
export function inertDeclarations(config: AgentConfig): InertDeclaration[] {
  const out: InertDeclaration[] = [];
  const net = config.permissions?.net ?? [];

  config.permissions?.net?.forEach((entry, i) => {
    const problem = netEntryProblem(entry);
    if (problem) {
      out.push({
        kind: "net_not_a_host",
        where: `permissions.net[${i}]`,
        advice: `permissions.net entry "${entry}" will never match a request because ${problem}. ` +
          `Entries are hostnames: use "${hostOf(entry) ?? entry.split("/")[0].split(":")[0]}".`,
      });
    }
  });

  config.http?.auth?.forEach((cred, i) => {
    const host = hostOf(cred.url);
    // A URL the runtime cannot parse is a separate problem the schema owns;
    // do not also claim it is unreachable.
    if (host === undefined) return;
    if (!net.some((p) => hostMatches(p, host))) {
      out.push({
        kind: "credential_unreachable",
        where: `http.auth[${i}].url`,
        advice: `http.auth credential for "${cred.url}" will never be attached: "${host}" is ` +
          `not in permissions.net, so the request is denied before the credential is reached. ` +
          `Add "${host}" to permissions.net, or drop the credential.`,
      });
    }
  });

  if (
    config.memory?.compact_at_tokens !== undefined &&
    config.memory.compact_at_tokens !== false &&
    config.memory.scope !== "thread"
  ) {
    out.push({
      kind: "compaction_without_history",
      where: "memory.compact_at_tokens",
      advice:
        `memory.compact_at_tokens is set but memory.scope is "${config.memory.scope}", so every ` +
        `run starts fresh and there is no history to compact. Set memory.scope: thread, or ` +
        `remove the threshold.`,
    });
  }

  if (
    config.limits.max_cost > 0 && !config.model.pricing && !priceFor(config.model.id)
  ) {
    out.push({
      kind: "cost_cap_without_price",
      where: "limits.max_cost",
      advice: `limits.max_cost is set but no price is known for model "${config.model.id}", so ` +
        `the cap cannot be enforced and run costs are not recorded. Set model.pricing, or set ` +
        `limits.max_cost: 0 to say the cap is not wanted.`,
    });
  }

  return out;
}
