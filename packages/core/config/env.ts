import { ConfigError } from "./load.ts";

const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ENV_REF_ANY = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Overrides for {@linkcode resolveEnv}, used by tests. */
export interface ResolveEnvOptions {
  /** Injectable for tests. */
  getEnv?: (name: string) => string | undefined;
  /** Injectable for tests; defaults to /run/secrets (Compose file secrets). */
  secretsDir?: string;
}

function readSecretFile(dir: string, name: string): string | undefined {
  try {
    return Deno.readTextFileSync(`${dir}/${name}`).trim();
  } catch {
    return undefined;
  }
}

/**
 * Read one secret the way the framework always reads them: env var first, then
 * /run/secrets/<NAME> (Compose file secrets). Undefined when it is set nowhere.
 */
export function lookupSecret(name: string, opts: ResolveEnvOptions = {}): string | undefined {
  const getEnv = opts.getEnv ?? Deno.env.get;
  return getEnv(name) ?? readSecretFile(opts.secretsDir ?? "/run/secrets", name);
}

/** The env var names a `${VAR}` template references, in order of appearance. */
export function envRefsIn(template: string): string[] {
  return [...template.matchAll(ENV_REF_ANY)].map((m) => m[1]);
}

function missing(name: string, forKey: string): ConfigError {
  return new ConfigError(
    `env reference \${${name}} (for "${forKey}") is not set: export ${name} or provide /run/secrets/${name}`,
  );
}

/**
 * Resolve an env block's `${VAR}` references: env var first, then
 * /run/secrets/<VAR> (Compose file secrets). Literal values pass through.
 * Missing references fail at startup — not mid-run in front of the model.
 */
export function resolveEnv(
  env: Record<string, string> | undefined,
  opts: ResolveEnvOptions = {},
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    const ref = value.match(ENV_REF);
    if (!ref) {
      resolved[key] = value;
      continue;
    }
    const fromEnv = lookupSecret(ref[1], opts);
    if (fromEnv === undefined) throw missing(ref[1], key);
    resolved[key] = fromEnv;
  }
  return resolved;
}

/**
 * Expand every `${VAR}` inside a string, so a credential can be written as the
 * header it becomes: `Bearer ${STRIPE_KEY}`. Missing references fail at
 * startup, like an env block's.
 */
export function expandEnvRefs(
  template: string,
  forKey: string,
  opts: ResolveEnvOptions = {},
): string {
  return template.replace(ENV_REF_ANY, (_, name: string) => {
    const value = lookupSecret(name, opts);
    if (value === undefined) throw missing(name, forKey);
    return value;
  });
}
