import type { Permissions } from "../config/schema.ts";
import { denoNetHosts } from "./hermetic.ts";
import { realPathSync } from "./paths.ts";

/** The permission axis a decision applies to. */
export type PermissionKind = "net" | "run" | "read" | "write";

/** The outcome of one permission check, recorded to the audit trail. */
export interface PermissionDecision {
  /** Whether the action is allowed. */
  allowed: boolean;
  /** Which axis was checked. */
  kind: PermissionKind;
  /** What was asked for (host, executable, path). */
  subject: string;
  /** Human/model-readable explanation, present on denials. */
  reason?: string;
}

/** Receives every permission decision, e.g. to write it to the audit store. */
export type AuditSink = (event: {
  kind: "permission";
  decision: PermissionDecision;
}) => void;

/**
 * `*.example.com` matches subdomains but not the apex; exact strings match
 * exactly. A bare `*` matches every host — the deliberate escape hatch for
 * agents whose job is the open web, and a statement loud enough to catch in
 * review.
 */
function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host !== pattern.slice(2);
  return pattern === host;
}

function pathMatches(prefix: string, path: string): boolean {
  const normal = prefix.endsWith("/") ? prefix : prefix + "/";
  return path === prefix || path.startsWith(normal);
}

/**
 * Deny-by-default permission checks. There is no `ask`: an undecided action
 * in an unattended agent must resolve to deny (Plan 1). Denials are normal
 * tool results the model can adapt to, and every decision is auditable.
 */
export class PermissionEngine {
  #permissions: Permissions;
  #audit?: AuditSink;
  #realPrefixes = new Map<string, string>();

  /** Create an engine over the config's allowlists; undefined permissions deny everything. */
  constructor(permissions: Permissions | undefined, audit?: AuditSink) {
    this.#permissions = permissions ?? {};
    this.#audit = audit;
  }

  /**
   * An allowed root, with its own symlinks expanded. Both sides of the
   * comparison have to speak in real paths: a root reached through a symlink
   * (`/tmp` on macOS, a symlinked data volume) would otherwise never match
   * the resolved path of a file inside it. Cached — roots don't move under a
   * running agent, and every file check consults them.
   */
  #realPrefix(prefix: string): string {
    let real = this.#realPrefixes.get(prefix);
    if (real === undefined) {
      real = realPathSync(prefix);
      this.#realPrefixes.set(prefix, real);
    }
    return real;
  }

  #decide(kind: PermissionKind, subject: string, allowed: boolean, hint: string) {
    const decision: PermissionDecision = {
      allowed,
      kind,
      subject,
      reason: allowed
        ? undefined
        : `permission denied: ${kind} access to "${subject}" is not in the agent's ${hint} allowlist`,
    };
    this.#audit?.({ kind: "permission", decision });
    return decision;
  }

  /** Check whether `host` is in the net allowlist. */
  net(host: string): PermissionDecision {
    const allowed = (this.#permissions.net ?? []).some((p) => hostMatches(p, host));
    return this.#decide("net", host, allowed, "permissions.net");
  }

  /**
   * `executable` is matched by basename, so `/usr/bin/gh` needs `run: [gh]`.
   * A bare `*` entry allows every executable — the same escape hatch `net`
   * has, and just as much a statement for review.
   */
  run(executable: string): PermissionDecision {
    const base = executable.split("/").at(-1) ?? executable;
    const list = this.#permissions.run ?? [];
    const allowed = list.includes("*") || list.includes(base);
    return this.#decide("run", executable, allowed, "permissions.run");
  }

  /**
   * Check whether `path` is under a read allowlist prefix. Pass a path with
   * its symlinks already expanded ({@linkcode realPath}) — the file tools do
   * this, and a lexical path checked here is a path that can lie about where
   * it leads.
   */
  read(path: string): PermissionDecision {
    const allowed = (this.#permissions.read ?? []).some((p) =>
      pathMatches(this.#realPrefix(p), path)
    );
    return this.#decide("read", path, allowed, "permissions.read");
  }

  /** Check whether `path` (symlinks already expanded) is under a write allowlist prefix. */
  write(path: string): PermissionDecision {
    const allowed = (this.#permissions.write ?? []).some((p) =>
      pathMatches(this.#realPrefix(p), path)
    );
    return this.#decide("write", path, allowed, "permissions.write");
  }
}

/**
 * Compile the declarative permissions to Deno CLI flags — enforcement layer 1
 * (the container is layer 2; see Plan 1). run_bash subprocesses escape Deno's
 * sandbox, so `run` permissions also compile to --allow-run.
 *
 * `--allow-net` matches exact hosts, so a `*.example.com` pattern has no
 * equivalent and is left out rather than approximated: the compiled flags are
 * always a subset of what the config allows, never a superset. The flags an
 * agent actually runs under come from {@linkcode hermeticPlan}, which refuses
 * to narrow a config it cannot express in full.
 */
export function permissionsToDenoFlags(permissions: Permissions | undefined): string[] {
  const p = permissions ?? {};
  const flags: string[] = [];
  const { hosts, open } = denoNetHosts(p.net);
  if (open) {
    flags.push("--allow-net");
  } else if (hosts.length) {
    flags.push(`--allow-net=${hosts.join(",")}`);
  }
  if (p.run?.includes("*")) flags.push("--allow-run");
  else if (p.run?.length) flags.push(`--allow-run=${p.run.join(",")}`);
  if (p.read?.length) flags.push(`--allow-read=${p.read.join(",")}`);
  if (p.write?.length) flags.push(`--allow-write=${p.write.join(",")}`);
  return flags;
}
