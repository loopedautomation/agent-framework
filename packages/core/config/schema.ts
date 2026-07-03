import { z } from "zod";

// Unknown keys are hard errors everywhere: in a config-driven framework a
// typo that silently no-ops is a security bug (e.g. a misspelled permission).

export const ModelConfigSchema = z.strictObject({
  provider: z.enum(["openai-compatible", "anthropic"]),
  id: z.string().min(1),
  /** Model role for cheap internal calls: summaries, compaction, labels. */
  small: z.string().min(1).optional(),
  base_url: z.url().optional(),
  /** Name of the env var holding the API key — a reference, never a value. */
  api_key_env: z.string().min(1).optional(),
  fallbacks: z.array(z.string().min(1)).optional(),
});

export const DiscordTriggerSchema = z.strictObject({
  type: z.literal("discord"),
  channels: z.array(z.string().min(1)).optional(),
  require_mention: z.boolean().optional(),
});

export const WebhookTriggerSchema = z.strictObject({
  type: z.literal("webhook"),
  path: z.string().startsWith("/").optional(),
});

export const CronTriggerSchema = z.strictObject({
  type: z.literal("cron"),
  schedule: z.string().min(1),
});

export const TriggerSchema = z.discriminatedUnion("type", [
  DiscordTriggerSchema,
  WebhookTriggerSchema,
  CronTriggerSchema,
]);

export const McpServerSchema = z
  .strictObject({
    name: z.string().min(1),
    /** stdio server: argv to launch it. */
    command: z.array(z.string().min(1)).optional(),
    /** HTTP server: endpoint URL. */
    url: z.url().optional(),
    /** Env vars passed to the server — values may be ${VAR} references. */
    env: z.record(z.string(), z.string()).optional(),
    /** Expose only these tools; a fat server must not blow the context. */
    include: z.array(z.string().min(1)).optional(),
  })
  .refine((s) => (s.command === undefined) !== (s.url === undefined), {
    message: "an MCP server needs exactly one of `command` (stdio) or `url` (http)",
  });

export const PermissionsSchema = z.strictObject({
  /** Hosts the agent may reach (http_request, MCP, providers are implicit). */
  net: z.array(z.string().min(1)).optional(),
  /** Executables run_bash may spawn. */
  run: z.array(z.string().min(1)).optional(),
  /** Readable path prefixes. */
  read: z.array(z.string().min(1)).optional(),
  /** Writable path prefixes. */
  write: z.array(z.string().min(1)).optional(),
});

export const MemoryConfigSchema = z.strictObject({
  scope: z.enum(["thread", "none"]).default("none"),
});

export const LimitsSchema = z.strictObject({
  /** Inner-loop iterations before the run ends with error_max_steps. */
  max_steps: z.number().int().positive().default(10),
  /** USD per run before the run ends with error_max_cost. */
  max_cost: z.number().positive().optional(),
});

export const AgentConfigSchema = z.strictObject({
  /**
   * The operator's handle for this agent (compose service, logs, CLI,
   * session keys). The agent chooses its own *name* on first boot.
   */
  nickname: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "nickname must be lowercase alphanumeric with hyphens (it names volumes, services, and log streams)",
    ),
  description: z.string().min(1),
  model: ModelConfigSchema,
  system_prompt: z.string().min(1),
  triggers: z.array(TriggerSchema).optional(),
  /** Paths to skill markdown files. */
  skills: z.array(z.string().min(1)).optional(),
  tools: z
    .strictObject({
      mcp: z.array(McpServerSchema).optional(),
      /** Paths to custom TypeScript tool modules. */
      custom: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  /** Deny-by-default: omitting this block means the agent can touch nothing. */
  permissions: PermissionsSchema.optional(),
  /** Values may be ${VAR} references, resolved at runtime and scoped per tool. */
  env: z.record(z.string(), z.string()).optional(),
  memory: MemoryConfigSchema.optional(),
  limits: LimitsSchema.default({ max_steps: 10 }),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type TriggerConfig = z.infer<typeof TriggerSchema>;
export type Permissions = z.infer<typeof PermissionsSchema>;

/** The published JSON Schema for agent.yaml (editor completion, validation). */
export function agentConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AgentConfigSchema, { io: "input" }) as Record<
    string,
    unknown
  >;
}
