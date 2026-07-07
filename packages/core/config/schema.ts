import { z } from "zod";

// Unknown keys are hard errors everywhere: in a config-driven framework a
// typo that silently no-ops is a security bug (e.g. a misspelled permission).
//
// Every field carries .describe() — the descriptions flow into the published
// JSON Schema (schema/agent.json) and become hover docs in editors via the
// yaml-language-server modeline. The schema IS the config documentation;
// don't let the two drift.

const ModelConfigSchema = z.strictObject({
  provider: z.enum(["openai-compatible", "anthropic", "codex"]).describe(
    "LLM provider dialect. openai-compatible covers OpenAI, Ollama, vLLM, and any compatible proxy. " +
      "codex uses an OpenAI Codex (ChatGPT) subscription via the credentials from `codex login` (no API key).",
  ),
  id: z.string().min(1).describe("Model identifier, e.g. gpt-5.4-mini or claude-sonnet-5."),
  small: z.string().min(1).optional().describe(
    "Model for cheap internal calls (summaries, compaction, the naming ritual). Defaults to the main model.",
  ),
  base_url: z.url().optional().describe(
    "Endpoint override, e.g. http://localhost:11434/v1 for Ollama with openai-compatible (no API key required with a base_url).",
  ),
  api_key_env: z.string().min(1).optional().describe(
    "Name of the env var holding the API key — a reference, never a value. Defaults to OPENAI_API_KEY / ANTHROPIC_API_KEY per provider.",
  ),
  fallbacks: z.array(z.string().min(1)).optional().describe(
    "Model ids to fall back to when the primary fails.",
  ),
}).describe("Which model runs this agent, and how to reach it.");

const DiscordTriggerSchema = z.strictObject({
  type: z.literal("discord"),
  channels: z.array(z.string().min(1)).optional().describe(
    "Channel names or ids to listen in; omit for all channels the bot can see. DMs always pass.",
  ),
  require_mention: z.boolean().optional().describe(
    "Only respond when the bot is @-mentioned. DMs always address the bot.",
  ),
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
  show_typing: z.boolean().default(false).describe(
    "Show the typing indicator in the source channel while the agent works. Looks odd with allow_silence: typing may end in no message.",
  ),
}).describe("Listen to Discord messages via the gateway; replies go in-channel by default.");

const SlackTriggerSchema = z.strictObject({
  type: z.literal("slack"),
  channels: z.array(z.string().min(1)).optional().describe(
    "Channel names or ids to listen in; omit for all channels the bot is in.",
  ),
  require_mention: z.boolean().optional().describe(
    "Only respond when the bot is @-mentioned. DMs always address the bot.",
  ),
  token_env: z.string().min(1).default("SLACK_BOT_TOKEN").describe(
    "Env var holding the bot token (xoxb-…) — reads channel info, posts replies.",
  ),
  app_token_env: z.string().min(1).default("SLACK_APP_TOKEN").describe(
    "Env var holding the app-level token (xapp-…, scope connections:write) for Socket Mode.",
  ),
  from_users: z.array(z.string().min(1)).optional().describe(
    "Only handle messages from these Slack user ids (U…); the filter runs before the model is called. Omit for anyone.",
  ),
  reply_channel: z.string().min(1).optional().describe(
    "Channel id to post replies into instead of the source thread. Out-of-channel replies quote the triggering message and link back.",
  ),
  allow_silence: z.boolean().default(false).describe(
    "Post nothing when the agent replies with exactly __NO_REPLY__ (or nothing). Instruct the sentinel in purpose.",
  ),
}).describe(
  "Listen to Slack messages via Socket Mode (no public endpoint); replies go in-thread by default.",
);

const TelegramTriggerSchema = z.strictObject({
  type: z.literal("telegram"),
  chats: z.array(z.string().min(1)).optional().describe(
    "Chat ids, group titles, or public @usernames to listen in; omit for all chats the bot sees.",
  ),
  require_mention: z.boolean().optional().describe(
    "Only respond when the bot is @-mentioned. Private chats always address the bot.",
  ),
  token_env: z.string().min(1).default("TELEGRAM_BOT_TOKEN").describe(
    "Env var holding the bot token from @BotFather.",
  ),
  from_users: z.array(z.string().min(1)).optional().describe(
    "Only handle messages from these authors (user ids or usernames); the filter runs before the model is called. Omit for anyone.",
  ),
  reply_chat: z.string().min(1).optional().describe(
    "Chat id to post replies into instead of the source chat. Out-of-chat replies quote the triggering message and link back.",
  ),
  allow_silence: z.boolean().default(false).describe(
    "Post nothing when the agent replies with exactly __NO_REPLY__ (or nothing). Instruct the sentinel in purpose.",
  ),
}).describe(
  "Listen to Telegram messages via Bot API long-polling (no public endpoint); replies go in-chat by default.",
);

const WebhookTriggerSchema = z.strictObject({
  type: z.literal("webhook"),
  path: z.string().startsWith("/").default("/").describe("HTTP path to serve."),
  port: z.number().int().min(1).max(65535).default(8080).describe("Port to listen on."),
  token_env: z.string().min(1).describe(
    "Env var holding the bearer token callers must present. Required: an unauthenticated endpoint contradicts deny-by-default.",
  ),
}).describe(
  "HTTP trigger: POST {path} with authorization: Bearer <token> and JSON body {input, conversation_id?}; responds with the run result.",
);

const ResendEmailTriggerSchema = z.strictObject({
  type: z.literal("email"),
  transport: z.literal("resend").describe(
    "How mail arrives. resend is the pushed transport: Resend receives mail for your domain and POSTs each message here as a signed webhook.",
  ),
  path: z.string().startsWith("/").default("/email").describe(
    "HTTP path the provider POSTs inbound-mail webhooks to.",
  ),
  port: z.number().int().min(1).max(65535).default(8080).describe("Port to listen on."),
  signing_secret_env: z.string().min(1).default("RESEND_WEBHOOK_SECRET").describe(
    "Env var holding the webhook signing secret (whsec_…). Every request is verified before parsing; unsigned POSTs get a 401.",
  ),
  api_key_env: z.string().min(1).default("RESEND_API_KEY").describe(
    "Env var holding the Resend API key — fetches message bodies and sends replies.",
  ),
  from_addresses: z.array(z.string().min(1)).min(1).describe(
    'Senders the agent handles: exact addresses or *@domain patterns. Required — an email address is open to the whole internet. ["*"] accepts anyone, stated in the file that defines the agent\'s reach.',
  ),
  allow_silence: z.boolean().default(false).describe(
    "Send nothing when the agent replies with exactly __NO_REPLY__ (or nothing). Instruct the sentinel in purpose.",
  ),
}).describe(
  "Wake on inbound email delivered by Resend's email.received webhook; replies go back out through the Resend API in the same thread.",
);

const EmailTriggerSchema = z.discriminatedUnion("transport", [
  ResendEmailTriggerSchema,
]).describe(
  "Wake on inbound email. transport picks how mail arrives; resend (pushed webhooks) is the only transport so far — IMAP and the hosted providers are planned.",
);

const CronTriggerSchema = z.strictObject({
  type: z.literal("cron"),
  schedule: z.string().min(1).describe('Cron expression, e.g. "0 9 * * 1" for Mondays 09:00.'),
  prompt: z.string().min(1).describe("What to tell the agent each tick."),
}).describe("Fire the agent on a schedule with a fixed prompt.");

const TriggerSchema = z.discriminatedUnion("type", [
  DiscordTriggerSchema,
  SlackTriggerSchema,
  TelegramTriggerSchema,
  WebhookTriggerSchema,
  EmailTriggerSchema,
  CronTriggerSchema,
]).describe("An event source that wakes the agent.");

const McpServerSchema = z
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
    readonly: z.boolean().optional().describe(
      "Expose only tools whose readOnlyHint annotation marks them read-only. A guard against wiring write tools into a read-only job; the hint is self-reported by the server.",
    ),
  })
  .refine((s) => (s.command === undefined) !== (s.url === undefined), {
    message: "an MCP server needs exactly one of `command` (stdio) or `url` (http)",
  })
  .describe("A Model Context Protocol server providing tools to the agent.");

const PermissionsSchema = z.strictObject({
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

const MemoryConfigSchema = z.strictObject({
  scope: z.enum(["thread", "none"]).default("none").describe(
    "thread: conversation history persists per conversation key (chat channel or thread, webhook conversation_id). none: every run starts fresh.",
  ),
  persistent: z.boolean().default(false).describe(
    "Give the agent remember/recall/list_memories/forget tools backed by its own SQLite file — " +
      "facts and preferences that survive across conversation keys and restarts, not just one thread's history.",
  ),
}).describe("What the agent remembers between events.");

const LimitsSchema = z.strictObject({
  max_steps: z.number().int().positive().default(20).describe(
    "Tool-calling iterations (LLM calls) per run. On hitting the cap the agent gets one final " +
      "tool-less call to summarize its progress, then the run ends with error_max_steps.",
  ),
}).describe("Per-run budgets — the dead-man's switches for unattended operation.");

const agentConfigSchema = z.strictObject({
  handle: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9-]*$/,
      "handle must be alphanumeric with hyphens (it names volumes, services, and log streams)",
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
      search: z.enum(["auto", "on", "off"]).default("auto").describe(
        "Tool search: defer MCP tool schemas out of context behind a search_tools tool. " +
          "auto defers when the agent has more than 10 tools; on always defers; off loads everything.",
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
}).describe(
  "A Looped AF agent: one job, one file. https://github.com/loopedautomation/agent-framework",
);

// The exported types below are written out by hand so the public API carries
// explicit types (JSR's no-slow-types rule; z.infer of a schema is not one).
// The _sync checks at the bottom of this file fail to compile if a type
// drifts from its schema, so the two cannot diverge silently.

/** The `model` block of an agent config: which model runs the agent, and how to reach it. */
export interface ModelConfig {
  /**
   * LLM provider dialect. openai-compatible covers OpenAI, Ollama, vLLM and compatible proxies;
   * codex uses an OpenAI Codex (ChatGPT) subscription via the credentials from `codex login`.
   */
  provider: "openai-compatible" | "anthropic" | "codex";
  /** Model identifier, e.g. gpt-5.4-mini or claude-sonnet-5. */
  id: string;
  /** Model for cheap internal calls. Defaults to the main model. */
  small?: string;
  /** Endpoint override for openai-compatible providers. */
  base_url?: string;
  /** Name of the env var holding the API key. */
  api_key_env?: string;
  /** Model ids to fall back to when the primary fails. */
  fallbacks?: string[];
}

/** A Discord trigger: listen to messages via the gateway. */
export interface DiscordTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "discord";
  /** Channel names or ids to listen in; omit for all channels the bot can see. DMs always pass. */
  channels?: string[];
  /** Only respond when the bot is @-mentioned. DMs always address the bot. */
  require_mention?: boolean;
  /** Env var holding the Discord bot token. */
  token_env: string;
  /** Only handle messages from these authors (user ids or usernames). */
  from_users?: string[];
  /** Channel id to post replies into instead of the source channel. */
  reply_channel?: string;
  /** Post nothing when the agent replies with exactly __NO_REPLY__ (or nothing). */
  allow_silence: boolean;
  /** Show the typing indicator in the source channel while the agent works. */
  show_typing: boolean;
}

/** A Slack trigger: listen to messages via Socket Mode. */
export interface SlackTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "slack";
  /** Channel names or ids to listen in; omit for all channels the bot is in. */
  channels?: string[];
  /** Only respond when the bot is @-mentioned. DMs always address the bot. */
  require_mention?: boolean;
  /** Env var holding the bot token (xoxb-…). */
  token_env: string;
  /** Env var holding the app-level token (xapp-…) for Socket Mode. */
  app_token_env: string;
  /** Only handle messages from these Slack user ids (U…). */
  from_users?: string[];
  /** Channel id to post replies into instead of the source thread. */
  reply_channel?: string;
  /** Post nothing when the agent replies with exactly __NO_REPLY__ (or nothing). */
  allow_silence: boolean;
}

/** A Telegram trigger: listen to messages via Bot API long-polling. */
export interface TelegramTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "telegram";
  /** Chat ids, group titles, or public @usernames to listen in. */
  chats?: string[];
  /** Only respond when the bot is @-mentioned. Private chats always address the bot. */
  require_mention?: boolean;
  /** Env var holding the bot token from @BotFather. */
  token_env: string;
  /** Only handle messages from these authors (user ids or usernames). */
  from_users?: string[];
  /** Chat id to post replies into instead of the source chat. */
  reply_chat?: string;
  /** Post nothing when the agent replies with exactly __NO_REPLY__ (or nothing). */
  allow_silence: boolean;
}

/** A webhook trigger: POST {path} with a bearer token and JSON body {input, conversation_id?}. */
export interface WebhookTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "webhook";
  /** HTTP path to serve. */
  path: string;
  /** Port to listen on. */
  port: number;
  /** Env var holding the bearer token callers must present. */
  token_env: string;
}

/** An email trigger on the Resend pushed transport: signed inbound-mail webhooks wake the agent. */
export interface ResendEmailTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "email";
  /** Discriminant for EmailTriggerConfig: how mail arrives. */
  transport: "resend";
  /** HTTP path the provider POSTs inbound-mail webhooks to. */
  path: string;
  /** Port to listen on. */
  port: number;
  /** Env var holding the webhook signing secret (whsec_…). */
  signing_secret_env: string;
  /** Env var holding the Resend API key — fetches message bodies and sends replies. */
  api_key_env: string;
  /** Senders the agent handles: exact addresses, `*@domain` patterns, or `*` for anyone. */
  from_addresses: string[];
  /** Send nothing when the agent replies with exactly __NO_REPLY__ (or nothing). */
  allow_silence: boolean;
}

/** An email trigger, discriminated on `transport`; resend is the only transport so far. */
export type EmailTriggerConfig = ResendEmailTriggerConfig;

/** A cron trigger: fire the agent on a schedule with a fixed prompt. */
export interface CronTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "cron";
  /** Cron expression, e.g. "0 9 * * 1" for Mondays 09:00. */
  schedule: string;
  /** What to tell the agent each tick. */
  prompt: string;
}

/** An event source that wakes the agent, discriminated on `type`. */
export type TriggerConfig =
  | DiscordTriggerConfig
  | SlackTriggerConfig
  | TelegramTriggerConfig
  | WebhookTriggerConfig
  | EmailTriggerConfig
  | CronTriggerConfig;

/** A Model Context Protocol server providing tools to the agent. */
export interface McpServerConfig {
  /** Server name; its tools appear namespaced as mcp__<name>__<tool>. */
  name: string;
  /** stdio server: argv to launch it. Exactly one of `command` or `url`. */
  command?: string[];
  /** HTTP server: the endpoint URL. Exactly one of `command` or `url`. */
  url?: string;
  /** Env vars passed to the server; values may be ${VAR} references. */
  env?: Record<string, string>;
  /** Expose only these tools. */
  include?: string[];
  /** Expose only tools whose readOnlyHint annotation marks them read-only. */
  readonly?: boolean;
}

/** Deny-by-default allowlists. Omitting a list means the agent can touch nothing on that axis. */
export interface Permissions {
  /** Hosts http_request may reach; *.example.com matches subdomains. */
  net?: string[];
  /** Executables run_bash may spawn, matched by basename. */
  run?: string[];
  /** Readable path prefixes. */
  read?: string[];
  /** Writable path prefixes. */
  write?: string[];
}

/** What the agent remembers between events. */
export interface MemoryConfig {
  /** thread: conversation history persists per conversation key. none: every run starts fresh. */
  scope: "thread" | "none";
  /** Give the agent remember/recall/list_memories/forget tools, backed by its own SQLite file. */
  persistent: boolean;
}

/** Per-run budgets. */
export interface LimitsConfig {
  /**
   * Tool-calling iterations (LLM calls) per run. On hitting the cap the agent gets one final
   * tool-less call to summarize its progress, then the run ends with error_max_steps.
   */
  max_steps: number;
}

/** A parsed and validated agent.yaml, with defaults applied. */
export interface AgentConfig {
  /** The operator's handle for this agent (compose service, logs, CLI, session keys). */
  handle: string;
  /** One line: what job this agent does. */
  description: string;
  /** Which model runs this agent, and how to reach it. */
  model: ModelConfig;
  /** The agent's job description; becomes the model's system prompt. */
  purpose: string;
  /** Event sources that wake the agent. */
  triggers?: TriggerConfig[];
  /** Paths to skill markdown files, relative to this config. */
  skills?: string[];
  /** Tool sources beyond the natives and skills. */
  tools?: {
    /** MCP servers to connect at startup. */
    mcp?: McpServerConfig[];
    /** Paths to custom TypeScript tool modules. Not yet implemented. */
    custom?: string[];
    /** Tool search: defer MCP tool schemas out of context behind a search_tools tool. */
    search: "auto" | "on" | "off";
  };
  /** Deny-by-default permission allowlists. */
  permissions?: Permissions;
  /** Env for tools and MCP servers; values may be ${VAR} references. */
  env?: Record<string, string>;
  /** What the agent remembers between events. */
  memory?: MemoryConfig;
  /** Per-run budgets. */
  limits: LimitsConfig;
}

/**
 * Zod schema for agent.yaml. Unknown keys are hard errors everywhere: in a
 * config-driven framework a typo that silently no-ops is a security bug.
 */
export const AgentConfigSchema: AgentConfigValidator = agentConfigSchema;

/**
 * The validation surface of {@linkcode AgentConfigSchema}. Documented as an
 * interface so the public API stays free of Zod's internal types.
 */
export interface AgentConfigValidator {
  /** Validate unknown data as an AgentConfig; throws on failure. */
  parse(data: unknown): AgentConfig;
  /** Validate without throwing; mirrors Zod's safeParse. */
  safeParse(
    data: unknown,
  ): { success: true; data: AgentConfig } | { success: false; error: Error };
}

/**
 * The env var each key-based provider reads its API key from when api_key_env
 * is omitted. codex is absent: it authenticates with OAuth credentials from
 * `codex login`, not an API key.
 */
export const DEFAULT_API_KEY_ENV: Record<Exclude<ModelConfig["provider"], "codex">, string> = {
  "openai-compatible": "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

// Compile-time drift guards: each fails if the hand-written type and the
// schema's inferred type stop being mutually assignable.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _agentConfigInSync: MutuallyAssignable<AgentConfig, z.infer<typeof agentConfigSchema>> = true;
const _triggerConfigInSync: MutuallyAssignable<TriggerConfig, z.infer<typeof TriggerSchema>> = true;
const _permissionsInSync: MutuallyAssignable<Permissions, z.infer<typeof PermissionsSchema>> = true;

/** The published JSON Schema for agent.yaml (editor completion, validation). */
export function agentConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(agentConfigSchema, { io: "input" }) as Record<
    string,
    unknown
  >;
}
