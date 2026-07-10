/**
 * The agent runtime for Looped AF: the agent loop, config loader, model
 * providers, permission engine, native tools, skills and the store. Everything
 * an agent process needs to load an agent.yaml, connect a model, and run.
 *
 * @module
 */

export {
  type AgentConfig,
  agentConfigJsonSchema,
  AgentConfigSchema,
  type AgentConfigValidator,
  type CronTriggerConfig,
  type DiscordTriggerConfig,
  type EmailTriggerConfig,
  type GmailEmailTriggerConfig,
  type ImapEmailTriggerConfig,
  type LimitsConfig,
  type McpServerConfig,
  type MemoryConfig,
  type ModelConfig,
  type OutlookEmailTriggerConfig,
  type Permissions,
  type ResendEmailTriggerConfig,
  type SlackTriggerConfig,
  type TelegramTriggerConfig,
  type TriggerConfig,
  type WebhookTriggerConfig,
} from "./config/schema.ts";
export {
  collectEnvRefs,
  ConfigError,
  loadAgentConfig,
  parseAgentConfig,
  resolveAgentConfig,
} from "./config/load.ts";
export { resolveEnv, type ResolveEnvOptions } from "./config/env.ts";
export {
  AnthropicProvider,
  type Completion,
  type CompletionRequest,
  createProvider,
  type Message,
  OpenAICompatibleProvider,
  type Provider,
  ProviderError,
  type ProviderErrorKind,
  type RetryOptions,
  type StopReason,
  type ToolCall,
  type ToolDef,
  type Usage,
  withRetry,
} from "./providers/mod.ts";
export {
  type PermissionDecision,
  PermissionEngine,
  type PermissionKind,
  permissionsToDenoFlags,
} from "./permissions/engine.ts";
export { defineTool, type NativeTool, type ToolArgs, type ToolSchema } from "./tools/types.ts";
export { currentTimeTool } from "./tools/time.ts";
export { createRunBashTool, extractExecutables, type RunBashOptions } from "./tools/bash.ts";
export { createHttpRequestTool, type HttpRequestOptions } from "./tools/http.ts";
export { createReadFileTool, createWriteFileTool } from "./tools/files.ts";
export { SEARCH_AUTO_THRESHOLD, ToolRegistry } from "./tools/registry.ts";
export {
  runAgent,
  type RunEvent,
  type RunOptions,
  type RunResult,
  type RunStatus,
} from "./loop/loop.ts";
export {
  createSkillTool,
  loadSkills,
  parseSkill,
  type Skill,
  skillsPromptSection,
} from "./skills/skills.ts";
export { connectMcpServers, type McpConnections, mcpToolsFromClient } from "./tools/mcp.ts";
export { type AgentIdentity, ensureIdentity, identityNote } from "./runtime/identity.ts";
export { startStatusServer, type StatusServerOptions } from "./runtime/status.ts";
export { type AuditRecord, type RunRecord, Store } from "./store/store.ts";
export {
  type AgentEvent,
  AgentService,
  type AgentServiceOptions,
  type HandleOptions,
  type Trigger,
} from "./runtime/service.ts";
export {
  type CaseResult,
  type EvalCase,
  type EvalCheck,
  type EvalFile,
  type EvalRunOptions,
  parseEvalFile,
  runEvalCases,
} from "./eval/eval.ts";

/** The @looped/core package version. */
export const VERSION = "0.5.0";
