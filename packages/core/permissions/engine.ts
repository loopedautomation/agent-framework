import { resolve } from "@std/path";
import type { Permissions } from "../config/schema.ts";

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

/** `*.example.com` matches subdomains but not the apex; exact strings match exactly. */
function hostMatches(pattern: string, host: string): boolean {
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

  /** Create an engine over the config's allowlists; undefined permissions deny everything. */
  constructor(permissions: Permissions | undefined, audit?: AuditSink) {
    this.#permissions = permissions ?? {};
    this.#audit = audit;
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

  /** `executable` is matched by basename, so `/usr/bin/gh` needs `run: [gh]`. */
  run(executable: string): PermissionDecision {
    const base = executable.split("/").at(-1) ?? executable;
    const allowed = (this.#permissions.run ?? []).includes(base);
    return this.#decide("run", executable, allowed, "permissions.run");
  }

  /** Check whether `path` (already resolved) is under a read allowlist prefix. */
  read(path: string): PermissionDecision {
    // Prefixes may be relative (resolved against cwd) — the checked path
    // arrives already resolved, so both sides normalize before matching.
    const allowed = (this.#permissions.read ?? []).some((p) => pathMatches(resolve(p), path));
    return this.#decide("read", path, allowed, "permissions.read");
  }

  /** Check whether `path` (already resolved) is under a write allowlist prefix. */
  write(path: string): PermissionDecision {
    const allowed = (this.#permissions.write ?? []).some((p) => pathMatches(resolve(p), path));
    return this.#decide("write", path, allowed, "permissions.write");
  }
}

/**
 * Compile the declarative permissions to Deno CLI flags — enforcement layer 1
 * (the container is layer 2; see Plan 1). run_bash subprocesses escape Deno's
 * sandbox, so `run` permissions also compile to --allow-run.
 */
export function permissionsToDenoFlags(permissions: Permissions | undefined): string[] {
  const p = permissions ?? {};
  const flags: string[] = [];
  if (p.net?.length) {
    flags.push(`--allow-net=${p.net.map((h) => h.replace(/^\*\./, "")).join(",")}`);
  }
  if (p.run?.length) flags.push(`--allow-run=${p.run.join(",")}`);
  if (p.read?.length) flags.push(`--allow-read=${p.read.join(",")}`);
  if (p.write?.length) flags.push(`--allow-write=${p.write.join(",")}`);
  return flags;
}
