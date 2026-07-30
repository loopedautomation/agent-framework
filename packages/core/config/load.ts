import { parse } from "@std/yaml";
import { z } from "zod";
import {
  type AgentConfig,
  AgentConfigSchema,
  DEFAULT_API_KEY_ENV,
  DEFAULT_VOICE_API_KEY_ENV,
} from "./schema.ts";

/** A configuration problem: invalid YAML, schema violation, or a missing reference. */
export class ConfigError extends Error {
  /** Create a ConfigError, optionally naming the file or config it came from. */
  constructor(
    message: string,
    /** The file or config the error came from. */
    readonly source?: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parse and validate agent YAML. Throws ConfigError with a readable message. */
export function parseAgentConfig(yamlText: string, source?: string): AgentConfig {
  let data: unknown;
  try {
    data = parse(yamlText);
  } catch (err) {
    throw new ConfigError(
      `${source ?? "config"} is not valid YAML: ${(err as Error).message}`,
      source,
    );
  }
  // Renamed keys get a migration hint, not a generic unknown-key error.
  if (typeof data === "object" && data !== null && "system_prompt" in data) {
    throw new ConfigError(
      `${
        source ?? "config"
      }: \`system_prompt\` was renamed to \`purpose\` — update the key and you're done`,
      source,
    );
  }
  if (typeof data === "object" && data !== null && "nickname" in data) {
    throw new ConfigError(
      `${
        source ?? "config"
      }: \`nickname\` was renamed to \`handle\` — update the key and you're done`,
      source,
    );
  }
  const tools = (data as Record<string, unknown> | null)?.["tools"] as
    | Record<string, unknown>
    | undefined;
  if (tools && "custom" in tools) {
    throw new ConfigError(
      `${source ?? "config"}: \`tools.custom\` is not a thing — the framework has no ` +
        `TypeScript tool modules. Wrap the code in an MCP server and declare it under \`mcp\`, ` +
        `or give the agent a CLI and a skill`,
      source,
    );
  }
  const result = AgentConfigSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigError(
      `${source ?? "config"} is not a valid agent definition:\n${
        z.prettifyError(result.error as z.ZodError)
      }`,
      source,
    );
  }
  return result.data;
}

/**
 * Resolve an agent definition from its two possible sources: a config file,
 * or the AF_AGENT_CONFIG env var holding the YAML itself (the file-less
 * deploy for platforms where env vars are easy and file mounts aren't).
 * Both present is a conflict and fails loudly — never guess which config runs.
 */
export async function resolveAgentConfig(
  path: string,
  getEnv: (name: string) => string | undefined = Deno.env.get,
): Promise<AgentConfig> {
  if (getEnv("LOOPED_AGENT_CONFIG")?.trim()) {
    throw new ConfigError(
      "LOOPED_AGENT_CONFIG was renamed to AF_AGENT_CONFIG; set the new name instead",
    );
  }
  const inline = getEnv("AF_AGENT_CONFIG");
  if (!inline?.trim()) return await loadAgentConfig(path);

  let fileExists = false;
  try {
    fileExists = (await Deno.stat(path)).isFile;
  } catch {
    // no file — the env var is the config
  }
  if (fileExists) {
    throw new ConfigError(
      `both AF_AGENT_CONFIG and ${path} are present — remove one so it's unambiguous which config runs`,
      path,
    );
  }
  return parseAgentConfig(inline, "AF_AGENT_CONFIG");
}

/** Load an agent definition from a YAML file. */
export async function loadAgentConfig(path: string): Promise<AgentConfig> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    throw new ConfigError(`cannot read ${path}: ${(err as Error).message}`, path);
  }
  return parseAgentConfig(text, path);
}

const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Env var names the config needs at runtime: `${VAR}` values in env blocks,
 * plus the API key env var — api_key_env when set, otherwise the provider's
 * default, matching createProvider. An openai-compatible model with a
 * base_url tolerates a missing key (local endpoints), so only an explicit
 * api_key_env counts there. codex needs no key at all — it authenticates
 * with `codex login` credentials.
 *
 * The voice engines are here for the same reason the model is: each resolves a
 * default key name when the config names none, and a key this function misses
 * is a key the redactor never learns about.
 */
export function collectEnvRefs(config: AgentConfig): string[] {
  const refs = new Set<string>();
  const { provider, api_key_env, base_url } = config.model;
  if (api_key_env) {
    refs.add(api_key_env);
  } else if (provider !== "codex" && !(provider === "openai-compatible" && base_url)) {
    refs.add(DEFAULT_API_KEY_ENV[provider]);
  }
  for (const engine of [config.voice?.stt, config.voice?.tts, config.voice?.live]) {
    if (engine) refs.add(engine.api_key_env ?? DEFAULT_VOICE_API_KEY_ENV[engine.provider]);
  }
  const scan = (env?: Record<string, string>) => {
    for (const value of Object.values(env ?? {})) {
      const m = value.match(ENV_REF);
      if (m) refs.add(m[1]);
    }
  };
  scan(config.env);
  for (const server of config.tools?.mcp ?? []) scan(server.env);
  return [...refs].sort();
}

/**
 * Every `*_env` name anywhere in the config — trigger tokens, voice keys,
 * whatever a future block adds. These are credentials by convention, so the
 * redactor learns them and a deploy surface should ask for them.
 */
export function credentialEnvNames(value: unknown, out: Set<string> = new Set()): Set<string> {
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

const ENV_REF_ANY = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Every env var name the agent needs at startup, secret or not: everything
 * collectEnvRefs finds, plus every `*_env` credential name, the `${VAR}`
 * references in `http.auth` values, and the ones in `purpose`. This is the
 * list a deploy surface should prompt for — a name missing here is a boot
 * failure the operator finds out about mid-deploy.
 *
 * Purpose references are the non-secret entries: they expand into the system
 * prompt, so they're required at startup but never join the redactor's list.
 */
export function requiredEnvRefs(config: AgentConfig): string[] {
  const refs = new Set<string>(collectEnvRefs(config));
  for (const name of credentialEnvNames(config)) refs.add(name);
  for (const auth of config.http?.auth ?? []) {
    for (const m of auth.value.matchAll(ENV_REF_ANY)) refs.add(m[1]);
    // The url takes references too: an instance hostname is deployment
    // configuration, and expandConfigHosts resolves it before the sandbox
    // flags are compiled from it.
    for (const m of auth.url.matchAll(ENV_REF_ANY)) refs.add(m[1]);
  }
  for (const host of config.permissions?.net ?? []) {
    for (const m of host.matchAll(ENV_REF_ANY)) refs.add(m[1]);
  }
  // Deliberately not in collectEnvRefs: that seeds the redactor, and the whole
  // point of `public` is that these values reach the agent's own output intact.
  // They are still required — an unset one fails at startup like any other —
  // so every surface that provisions an agent's environment has to see them.
  for (const value of Object.values(config.public ?? {})) {
    for (const m of value.matchAll(ENV_REF_ANY)) refs.add(m[1]);
  }
  for (const m of config.purpose.matchAll(ENV_REF_ANY)) refs.add(m[1]);
  return [...refs].sort();
}
