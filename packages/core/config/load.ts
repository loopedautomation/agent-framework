import { parse } from "@std/yaml";
import { z } from "zod";
import { type AgentConfig, AgentConfigSchema, DEFAULT_API_KEY_ENV } from "./schema.ts";

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
 */
export function collectEnvRefs(config: AgentConfig): string[] {
  const refs = new Set<string>();
  const { provider, api_key_env, base_url } = config.model;
  if (api_key_env) {
    refs.add(api_key_env);
  } else if (provider !== "codex" && !(provider === "openai-compatible" && base_url)) {
    refs.add(DEFAULT_API_KEY_ENV[provider]);
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
