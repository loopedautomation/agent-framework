import type { AgentConfig } from "../config/schema.ts";
import { collectEnvRefs } from "../config/load.ts";
import { envRefsIn, lookupSecret, type ResolveEnvOptions } from "../config/env.ts";

/** What replaces a secret wherever one surfaces. */
export const REDACTED = "[redacted]";

/**
 * Shorter values are ignored. An env block may hold `1` or `true`, and
 * substituting a value that short would shred every tool result it touches.
 */
const MIN_SECRET_LENGTH = 6;

/**
 * Keys whose value is a credential whatever it holds. Redacted by name, so a
 * header the agent built from a secret the framework never resolved (an OAuth
 * token it fetched mid-run) still does not reach the transcript.
 */
const DEFAULT_SENSITIVE_KEYS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
];

/** Inputs to a {@linkcode Redactor}. */
export interface RedactorOptions {
  /** Secret values to scrub wherever they appear. Undefined entries are skipped. */
  values?: Iterable<string | undefined>;
  /** Extra header/field names whose value is scrubbed, on top of the defaults. */
  headers?: Iterable<string>;
}

/**
 * Encodings a secret can wear by the time it reaches an output surface: raw,
 * URL-encoded (a query string), base64 (a Basic auth header), and
 * JSON-escaped (a body the tool serialized).
 */
function variants(value: string): string[] {
  const out = [value];
  const uri = encodeURIComponent(value);
  if (uri !== value) out.push(uri);
  const json = JSON.stringify(value).slice(1, -1);
  if (json !== value) out.push(json);
  try {
    out.push(btoa(value));
  } catch {
    // Not latin1; it was never going into a base64 header either.
  }
  return out;
}

/**
 * The one place a secret is scrubbed. Built once per agent from the resolved
 * values of every env var its config references, then applied to every surface
 * a value could escape through: tool results, the model transcript, the store,
 * the status API, logs and the run event stream.
 *
 * Scoped env keeps secrets out of the model's *initial* context; this keeps
 * them out of everything downstream, because a permitted CLI or MCP server can
 * always echo one back.
 */
export class Redactor {
  /** Longest first, so an overlapping value is never half-substituted. */
  #values: string[] = [];
  #keys: Set<string>;

  /** Build a redactor. With no values it still scrubs sensitive keys by name. */
  constructor(opts: RedactorOptions = {}) {
    this.#keys = new Set(
      [...DEFAULT_SENSITIVE_KEYS, ...(opts.headers ?? [])].map((h) => h.toLowerCase()),
    );
    this.add(...(opts.values ?? []));
  }

  /** Teach the redactor another secret; a token refreshed mid-run needs this. */
  add(...values: (string | undefined)[]): void {
    for (const value of values) {
      if (!value || value.trim().length < MIN_SECRET_LENGTH) continue;
      for (const v of variants(value)) {
        if (!this.#values.includes(v)) this.#values.push(v);
      }
    }
    this.#values.sort((a, b) => b.length - a.length);
  }

  /** Whether any secret value is known. Sensitive keys are scrubbed regardless. */
  get active(): boolean {
    return this.#values.length > 0;
  }

  /** Substitute every known secret value in a string. */
  text(value: string): string {
    let out = value;
    for (const secret of this.#values) out = out.replaceAll(secret, REDACTED);
    return out;
  }

  /**
   * Walk a JSON-shaped value: every string is scrubbed, and any field named
   * like a credential header is dropped whatever it holds. Returns a copy;
   * the input is untouched.
   */
  deep<T>(value: T): T {
    return this.#walk(value) as T;
  }

  #walk(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.#walk(v));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        out[key] = this.#keys.has(key.toLowerCase()) && typeof v === "string"
          ? REDACTED
          : this.#walk(v);
      }
      return out;
    }
    return value;
  }

  /**
   * Scrub a string that may be serialized JSON (a tool result, a tool call's
   * arguments), so sensitive keys inside it are caught too. Falls back to a
   * plain value substitution when it is not JSON.
   */
  jsonText(value: string): string {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return JSON.stringify(this.deep(parsed));
    } catch {
      // Not JSON — plain text is the common case.
    }
    return this.text(value);
  }
}

// The agent process is one agent (Plan 0), so surfaces with no injection seam
// of their own — provider error bodies, the log path — reach the redactor here.
let current = new Redactor();

/** Install the process-wide redactor. {@linkcode AgentService} does this at startup. */
export function setDefaultRedactor(redactor: Redactor): void {
  current = redactor;
}

/** The process-wide redactor; a no-op one until an agent installs its own. */
export function defaultRedactor(): Redactor {
  return current;
}

/** Scrub a string with the process-wide redactor. */
export function redactText(value: string): string {
  return current.text(value);
}

/** Every `<something>_env` value in the config: the env var names holding credentials. */
function credentialEnvNames(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) credentialEnvNames(v, out);
  } else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key.endsWith("_env") && typeof v === "string") out.add(v);
      else credentialEnvNames(v, out);
    }
  }
  return out;
}

/**
 * Build an agent's redactor from its config. Seeded from the *values* behind
 * every env var name the config references: the `${VAR}` refs in its env
 * blocks, the `*_env` names its model and triggers authenticate with, the refs
 * in its http credentials, and anything listed under `redact.values`. Each is
 * resolved the way scoped env is — env var first, then /run/secrets/<VAR>.
 *
 * A literal written into the config is not a secret (it is committed), so it
 * is not redacted; a value that never resolved is not a secret either.
 */
export function redactorForConfig(config: AgentConfig, opts: ResolveEnvOptions = {}): Redactor {
  const names = new Set<string>([...collectEnvRefs(config), ...credentialEnvNames(config)]);
  for (const auth of config.http?.auth ?? []) {
    for (const ref of envRefsIn(auth.value)) names.add(ref);
  }
  for (const value of config.redact?.values ?? []) {
    for (const ref of envRefsIn(value)) names.add(ref);
  }
  return new Redactor({
    values: [...names].map((name) => lookupSecret(name, opts)),
    headers: config.redact?.headers,
  });
}
