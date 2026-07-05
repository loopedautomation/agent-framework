import { ConfigError } from "./load.ts";

const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

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
 * Resolve an env block's `${VAR}` references: env var first, then
 * /run/secrets/<VAR> (Compose file secrets). Literal values pass through.
 * Missing references fail at startup — not mid-run in front of the model.
 */
export function resolveEnv(
  env: Record<string, string> | undefined,
  opts: ResolveEnvOptions = {},
): Record<string, string> {
  const getEnv = opts.getEnv ?? Deno.env.get;
  const secretsDir = opts.secretsDir ?? "/run/secrets";
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    const ref = value.match(ENV_REF);
    if (!ref) {
      resolved[key] = value;
      continue;
    }
    const name = ref[1];
    const fromEnv = getEnv(name) ?? readSecretFile(secretsDir, name);
    if (fromEnv === undefined) {
      throw new ConfigError(
        `env reference \${${name}} (for "${key}") is not set: export ${name} or provide /run/secrets/${name}`,
      );
    }
    resolved[key] = fromEnv;
  }
  return resolved;
}
