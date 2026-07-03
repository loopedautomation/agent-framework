import { parse } from "@std/yaml";
import { z } from "zod";
import { type AgentConfig, AgentConfigSchema } from "./schema.ts";

export class ConfigError extends Error {
  constructor(message: string, readonly source?: string) {
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
  // Accepted-but-ignored config is a lie (#12): until custom TS tools are
  // implemented, declaring them is a loud error, not a silent no-op.
  const tools = (data as Record<string, unknown> | null)?.["tools"] as
    | Record<string, unknown>
    | undefined;
  if (tools && "custom" in tools) {
    throw new ConfigError(
      `${source ?? "config"}: tools.custom is not implemented yet — remove it for now ` +
        `(custom TypeScript tools are tracked in issue #12)`,
      source,
    );
  }
  const result = AgentConfigSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigError(
      `${source ?? "config"} is not a valid agent definition:\n${z.prettifyError(result.error)}`,
      source,
    );
  }
  return result.data;
}

/**
 * Resolve an agent definition from its two possible sources: a config file,
 * or the LOOPED_AGENT_CONFIG env var holding the YAML itself (the file-less
 * deploy for platforms where env vars are easy and file mounts aren't).
 * Both present is a conflict and fails loudly — never guess which config runs.
 */
export async function resolveAgentConfig(
  path: string,
  getEnv: (name: string) => string | undefined = Deno.env.get,
): Promise<AgentConfig> {
  const inline = getEnv("LOOPED_AGENT_CONFIG");
  if (!inline?.trim()) return await loadAgentConfig(path);

  let fileExists = false;
  try {
    fileExists = (await Deno.stat(path)).isFile;
  } catch {
    // no file — the env var is the config
  }
  if (fileExists) {
    throw new ConfigError(
      `both LOOPED_AGENT_CONFIG and ${path} are present — remove one so it's unambiguous which config runs`,
      path,
    );
  }
  return parseAgentConfig(inline, "LOOPED_AGENT_CONFIG");
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
 * Env var names referenced by the config (`${VAR}` values in env blocks and
 * `api_key_env`). The config only ever holds references — never secret values.
 */
export function collectEnvRefs(config: AgentConfig): string[] {
  const refs = new Set<string>();
  if (config.model.api_key_env) refs.add(config.model.api_key_env);
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
