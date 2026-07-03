// @looped/af — agent loop, config loader, providers, permissions, memory.

export {
  type AgentConfig,
  agentConfigJsonSchema,
  AgentConfigSchema,
  type ModelConfig,
  type Permissions,
  type TriggerConfig,
} from "./config/schema.ts";
export { collectEnvRefs, ConfigError, loadAgentConfig, parseAgentConfig } from "./config/load.ts";
export {
  AnthropicProvider,
  type Completion,
  type CompletionRequest,
  createProvider,
  type Message,
  OpenAICompatibleProvider,
  type Provider,
  ProviderError,
  type ToolCall,
  type ToolDef,
  type Usage,
  withRetry,
} from "./providers/mod.ts";
export { defineTool, type NativeTool } from "./tools/types.ts";
export { currentTimeTool } from "./tools/time.ts";
export { runAgent, type RunOptions, type RunResult, type RunStatus } from "./loop/loop.ts";

export const VERSION = "0.1.0";
