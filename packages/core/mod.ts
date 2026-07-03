// @looped/core — agent loop, config loader, providers, permissions, memory.

export {
  type AgentConfig,
  agentConfigJsonSchema,
  AgentConfigSchema,
  type ModelConfig,
  type Permissions,
  type TriggerConfig,
} from "./config/schema.ts";
export { collectEnvRefs, ConfigError, loadAgentConfig, parseAgentConfig } from "./config/load.ts";

export const VERSION = "0.0.0";
