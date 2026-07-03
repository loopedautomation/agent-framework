import { z } from "zod";

// Unknown keys are hard errors everywhere: in a config-driven framework a
// typo that silently no-ops is a security bug (e.g. a misspelled permission).
//
// Every field carries .describe() — the descriptions flow into the published
// JSON Schema (schema/agent.json) and become hover docs in editors via the
// yaml-language-server modeline. The schema IS the config documentation;
// don't let the two drift.

export const ModelConfigSchema = z.strictObject({
  provider: z.enum(["openai-compatible", "anthropic"]).describe(
    "LLM provider dialect. openai-compatible covers OpenAI, Ollama, vLLM, and any compatible proxy.",
  ),
  id: z.string().min(1).describe("Model identifier, e.g. gpt-5.4-mini or claude-sonnet-5."),
  small: z.string().min(1).optional().describe(
    "Model for cheap internal calls (summaries, compaction, the naming ritual). Defaults to the main model.",
  ),
  base_url: z.url().optional().describe(
    "Endpoint override for openai-compatible providers, e.g. http://localhost:11434/v1 for Ollama (no API key required with a base_url).",
  ),
  api_key_env: z.string().min(1).optional().describe(
    "Name of the env var holding the API key — a reference, never a value. Defaults to OPENAI_API_KEY / ANTHROPIC_API_KEY per provider.",
  ),
  fallbacks: z.array(z.string().min(1)).optional().describe(
    "Model ids to fall back to when the primary fails.",
  ),
  pricing: z
    .strictObject({
      input_per_mtok: z.number().nonnegative().describe("USD per million input tokens."),
      output_per_mtok: z.number().nonnegative().describe("USD per million output tokens."),
    })
    .optional()
    .describe(
      "USD per million tokens; enables per-run cost reporting and is required when limits.max_cost is set. Explicit until models.dev integration lands.",
    ),
}).describe("Which model runs this agent, and how to reach it.");

export const DiscordTriggerSchema = z.strictObject({
  type: z.literal("discord"),
  channels: z.array(z.string().min(1)).optional().describe(
    "Channel names or ids to listen in; omit for all channels the bot can see.",
  ),
  require_mention: z.boolean().optional().describe("Only respond when the bot is @-mentioned."),
  token_env: z.string().min(1).default("DISCORD_BOT_TOKEN").describe(
    "Env var holding the Discord bot token.",
  ),
  from_users: z.array(z.string().min(1)).optional().describe(
    "Only handle messages from these authors (user ids or usernames); the filter runs before the model is called. Omit for anyone.",
  ),
  reply_channel: z.string().min(1).optional().describe(
    "Channel id to post replies into instead of the source channel. Out-of-channel replies quote the triggering message and link back.",
  ),
  allow_silence: z.boolean().default(false).describe(
    "Post nothing when the agent replies with exactly __NO_REPLY__ (or nothing). Instruct the sentinel in purpose.",
  ),
}).describe("Listen to Discord messages via the gateway; replies go in-channel by default.");

export const WebhookTriggerSchema = z.strictObject({
  type: z.literal("webhook"),
  path: z.string().startsWith("/").default("/").describe("HTTP path to serve."),
  port: z.number().int().min(1).max(65535).default(8080).describe("Port to listen on."),
  token_env: z.string().min(1).describe(
    "Env var holding the bearer token callers must present. Required: an unauthenticated endpoint contradicts deny-by-default.",
  ),
}).describe(
  "HTTP trigger: POST {path} with authorization: Bearer <token> and JSON body {input, conversation_id?}; responds with the run result.",
);

export const CronTriggerSchema = z.strictObject({
  type: z.literal("cron"),
  schedule: z.string().min(1).describe('Cron expression, e.g. "0 9 * * 1" for Mondays 09:00.'),
  prompt: z.string().min(1).describe("What to tell the agent each tick."),
}).describe("Fire the agent on a schedule with a fixed prompt.");

export const TriggerSchema = z.discriminatedUnion("type", [
  DiscordTriggerSchema,
  WebhookTriggerSchema,
  CronTriggerSchema,
]).describe("An event source that wakes the agent.");

export const McpServerSchema = z
  .strictObject({
    name: z.string().min(1).describe(
      "Server name; its tools appear namespaced as mcp__<name>__<tool>.",
    ),
    command: z.array(z.string().min(1)).optional().describe(
      "stdio server: argv to launch it, e.g. [docker, run, -i, ghcr.io/github/github-mcp-server].",
    ),
    url: z.url().optional().describe("HTTP server: the endpoint URL."),
    env: z.record(z.string(), z.string()).optional().describe(
      "Env vars passed to the server — values may be ${VAR} references. The server sees only these (scoped, no ambient inheritance).",
    ),
    include: z.array(z.string().min(1)).optional().describe(
      "Expose only these tools. Strongly recommended: a fat server must not blow a small model's context.",
    ),
  })
  .refine((s) => (s.command === undefined) !== (s.url === undefined), {
    message: "an MCP server needs exactly one of `command` (stdio) or `url` (http)",
  })
  .describe("A Model Context Protocol server providing tools to the agent.");

export const PermissionsSchema = z.strictObject({
  net: z.array(z.string().min(1)).optional().describe(
    "Hosts http_request may reach; *.example.com matches subdomains (not the apex).",
  ),
  run: z.array(z.string().min(1)).optional().describe(
    "Executables run_bash may spawn, matched by basename. run_bash exists only if this grants something.",
  ),
  read: z.array(z.string().min(1)).optional().describe("Readable path prefixes."),
  write: z.array(z.string().min(1)).optional().describe("Writable path prefixes."),
}).describe(
  "Deny-by-default allowlists. Omitting this block means the agent can touch nothing; denials are surfaced to the model as tool results.",
);

export const MemoryConfigSchema = z.strictObject({
  scope: z.enum(["thread", "none"]).default("none").describe(
    "thread: conversation history persists per conversation key (Discord channel, webhook conversation_id). none: every run starts fresh.",
  ),
}).describe("What the agent remembers between events.");

export const LimitsSchema = z.strictObject({
  max_steps: z.number().int().positive().default(20).describe(
    "Inner-loop iterations (LLM calls) before the run ends with error_max_steps.",
  ),
  max_cost: z.number().positive().optional().describe(
    "USD per run before the run ends with error_max_cost. Requires model.pricing.",
  ),
}).describe("Per-run budgets — the dead-man's switches for unattended operation.");

export const AgentConfigSchema = z.strictObject({
  nickname: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "nickname must be lowercase alphanumeric with hyphens (it names volumes, services, and log streams)",
    )
    .describe(
      "The operator's handle for this agent (compose service, logs, CLI, session keys). The agent chooses its own name on first boot.",
    ),
  description: z.string().min(1).describe(
    "One line: what job this agent does. Also shown to the agent during the naming ritual.",
  ),
  model: ModelConfigSchema,
  purpose: z.string().min(1).describe(
    "The agent's job description — what it does, how it behaves, when to stay quiet. Becomes the model's system prompt.",
  ),
  triggers: z.array(TriggerSchema).optional().describe(
    "Event sources that wake the agent. With triggers, `af run` starts a long-lived service; without, an interactive REPL.",
  ),
  skills: z.array(z.string().min(1)).optional().describe(
    "Paths to skill markdown files (relative to this config). Skills carry knowledge, never capability.",
  ),
  tools: z
    .strictObject({
      mcp: z.array(McpServerSchema).optional().describe("MCP servers to connect at startup."),
      custom: z.array(z.string().min(1)).optional().describe(
        "Paths to custom TypeScript tool modules. Not yet implemented (issue #12).",
      ),
    })
    .optional()
    .describe("Tool sources beyond the natives and skills."),
  permissions: PermissionsSchema.optional(),
  env: z.record(z.string(), z.string()).optional().describe(
    "Env for tools and MCP servers. Values may be ${VAR} references, resolved at startup (env var, then /run/secrets/<VAR>) and scoped per tool.",
  ),
  memory: MemoryConfigSchema.optional(),
  limits: LimitsSchema.default({ max_steps: 20 }),
}).refine((c) => c.limits.max_cost === undefined || c.model.pricing !== undefined, {
  message:
    "limits.max_cost requires model.pricing (a cost cap can't be enforced without prices; models.dev integration is planned)",
  path: ["limits", "max_cost"],
}).describe(
  "A Looped AF agent: one job, one file. https://github.com/loopedautomation/agent-framework",
);

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
