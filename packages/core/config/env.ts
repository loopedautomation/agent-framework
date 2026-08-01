import { ConfigError } from "./load.ts";
import type { AgentConfig } from "./schema.ts";

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

/** Leave an unset `${VAR}` in place instead of failing — for describing a config. */
function expandEnvRefsLenient(template: string, opts: ResolveEnvOptions): string {
  return template.replace(ENV_REF_ANY, (whole, name: string) => lookupSecret(name, opts) ?? whole);
}

/**
 * Expand `${VAR}` in the two fields that name *where* the agent may go:
 * `permissions.net` entries and each `http.auth` url. An instance hostname is
 * deployment configuration, not a secret, and baking it into a committed
 * agent file is what this avoids.
 *
 * This has to run before {@linkcode hermeticPlan}, because an expanded host is
 * what gets compiled into `--allow-net` — a config that reached the sandbox
 * still holding `${COOLIFY_HOST}` would be allowlisting a literal that no DNS
 * name matches. {@linkcode resolveEnv} handles the env block, and the service
 * handles `purpose` and `http.auth.value`; this closes the remaining two.
 *
 * Unlike a credential, an unresolved host is not a security failure, so
 * `lenient` leaves it in place for surfaces that describe a config rather than
 * run it (`af validate` off the deployment host). Running paths pass
 * `lenient: false` and fail at startup, like every other missing reference.
 *
 * Returns the config unchanged when nothing references anything, so the common
 * case allocates nothing.
 */
export function expandConfigHosts(
  config: AgentConfig,
  opts: ResolveEnvOptions & { lenient?: boolean } = {},
): AgentConfig {
  const net = config.permissions?.net;
  const auth = config.http?.auth;
  const touches = (s: string) => ENV_REF_ANY.test(s);
  ENV_REF_ANY.lastIndex = 0; // the regex is global; `test` is stateful without this
  const needed = (net ?? []).some(touches) || (auth ?? []).some((a) => touches(a.url));
  ENV_REF_ANY.lastIndex = 0;
  if (!needed) return config;

  const expand = (value: string, forKey: string) =>
    opts.lenient ? expandEnvRefsLenient(value, opts) : expandEnvRefs(value, forKey, opts);

  return {
    ...config,
    ...(net
      ? {
        permissions: {
          ...config.permissions,
          net: net.map((host) => expand(host, "permissions.net")),
        },
      }
      : {}),
    ...(auth
      ? {
        http: {
          ...config.http,
          auth: auth.map((a) => ({ ...a, url: expand(a.url, `http.auth ${a.url}`) })),
        },
      }
      : {}),
  };
}
