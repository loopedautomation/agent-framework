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
  type CommandConfig,
  type CronTriggerConfig,
  DEFAULT_VOICE_API_KEY_ENV,
  type DiscordTriggerConfig,
  type EmailTriggerConfig,
  type GithubTriggerConfig,
  type GmailEmailTriggerConfig,
  type HttpAuthConfig,
  type HttpConfig,
  type ImapEmailTriggerConfig,
  type LimitsConfig,
  type LiveVoiceConfig,
  type McpServerConfig,
  type MemoryConfig,
  type ModelConfig,
  type OutlookEmailTriggerConfig,
  type Permissions,
  type RedactConfig,
  type ResendEmailTriggerConfig,
  type SlackTriggerConfig,
  type TelegramTriggerConfig,
  type TriggerConfig,
  type TtyTriggerConfig,
  type VoiceConfig,
  type VoiceSttConfig,
  type VoiceTtsConfig,
  type WebhookTriggerConfig,
} from "./config/schema.ts";
export {
  collectEnvRefs,
  ConfigError,
  credentialEnvNames,
  loadAgentConfig,
  parseAgentConfig,
  requiredEnvRefs,
  resolveAgentConfig,
} from "./config/load.ts";
export {
  envRefsIn,
  expandEnvRefs,
  lookupSecret,
  resolveEnv,
  type ResolveEnvOptions,
} from "./config/env.ts";
export {
  defaultRedactor,
  REDACTED,
  Redactor,
  redactorForConfig,
  type RedactorOptions,
  redactText,
  setDefaultRedactor,
} from "./redact/redact.ts";
export { logError, logInfo, logWarn } from "./runtime/log.ts";
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
export {
  runGrantAdvisories,
  type RunGrantAdvisory,
  type RunGrantHazard,
} from "./permissions/advisories.ts";
export type { ImageContent } from "./providers/types.ts";
export {
  type Attachment,
  isImageType,
  type MediaLimits,
  resolveAttachments,
  type ResolvedMedia,
  withNotes,
} from "./media/media.ts";
export {
  denoNetHosts,
  derivedHosts,
  type Env,
  type HermeticPlan,
  hermeticPlan,
  IMAGE_ENV,
  IMAGE_FLAGS,
  RUNTIME_READ_PATHS,
  RUNTIME_WRITE_PATHS,
} from "./permissions/hermetic.ts";
export { defineTool, type NativeTool, type ToolArgs, type ToolSchema } from "./tools/types.ts";
export { currentTimeTool } from "./tools/time.ts";
export { createRunBashTool, extractExecutables, type RunBashOptions } from "./tools/bash.ts";
export {
  createHttpRequestTool,
  type HttpCredential,
  type HttpRequestOptions,
} from "./tools/http.ts";
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
export {
  BUILTIN_COMMANDS,
  type CommandSpec,
  commandSpecs,
  parseCommand,
  type ParsedCommand,
} from "./runtime/commands.ts";
export { startStatusServer, type StatusServerOptions } from "./runtime/status.ts";
export { type AuditRecord, type RunRecord, Store, type StoreOptions } from "./store/store.ts";
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
export const VERSION = "0.12.0";
