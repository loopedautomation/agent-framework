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
  const result = AgentConfigSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigError(
      `${source ?? "config"} is not a valid agent definition:\n${z.prettifyError(result.error)}`,
      source,
    );
  }
  return result.data;
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
