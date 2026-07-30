import { z } from "zod";

// Unknown keys are hard errors everywhere: in a config-driven framework a
// typo that silently no-ops is a security bug (e.g. a misspelled permission).
//
// Every field carries .describe() — the descriptions flow into the published
// JSON Schema (schema/agent.json) and become hover docs in editors via the
// yaml-language-server modeline. The schema IS the config documentation;
// don't let the two drift.

const ModelConfigSchema = z.strictObject({
  provider: z.enum(["openai-compatible", "anthropic", "gemini", "codex"]).describe(
    "LLM provider dialect. openai-compatible covers OpenAI, Ollama, vLLM, and any compatible proxy. " +
      "gemini is the native Gemini API (generateContent). " +
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
    "Name of the env var holding the API key — a reference, never a value. Defaults to OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY per provider.",
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
    "Post nothing when the agent replies with __NO_REPLY__ (or nothing); punctuation and whitespace around the sentinel are tolerated. Instruct the sentinel in purpose.",
  ),
  show_typing: z.boolean().default(false).describe(
    "Show the typing indicator in the source channel while the agent works. Looks odd with allow_silence: typing may end in no message.",
  ),
  voice_channels: z.array(z.string().min(1)).optional().describe(
    "Voice channel names or ids to join for live spoken conversations. Requires the top-level " +
      "voice.live block; the bot joins at startup and stays. Live voice media rides UDP, which " +
      "keeps the agent out of hermetic mode — the container is its egress boundary.",
  ),
}).describe("Listen to Discord messages via the gateway; replies go in-channel by default.");

const SlackTriggerSchema = z.strictObject({
  type: z.literal("slack"),
  transport: z.enum(["socket", "events_api"]).default("socket").describe(
    "How events arrive. socket holds a Socket Mode connection open (no public endpoint, needs an " +
      "always-on process). events_api serves Slack's Events API over inbound HTTP, so the host " +
      "can scale to zero between messages — but needs a public HTTPS endpoint (the request URL " +
      "in the Slack app config).",
  ),
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
    "Env var holding the app-level token (xapp-…, scope connections:write). Only the socket " +
      "transport needs it.",
  ),
  port: z.number().int().min(1).max(65535).default(8080).describe(
    "events_api transport: port to listen on.",
  ),
  path: z.string().startsWith("/").default("/slack").describe(
    "events_api transport: HTTP path Slack POSTs event deliveries to.",
  ),
  signing_secret_env: z.string().min(1).default("SLACK_SIGNING_SECRET").describe(
    "events_api transport: env var holding the app's signing secret. Every delivery's " +
      "X-Slack-Signature is verified before parsing; unsigned POSTs get a 401.",
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
  "Listen to Slack messages via Socket Mode (default, no public endpoint) or the Events API " +
    "(inbound HTTP, scale-to-zero friendly); replies go in-thread by default.",
);

const TelegramTriggerSchema = z.strictObject({
  type: z.literal("telegram"),
  transport: z.enum(["polling", "webhook"]).default("polling").describe(
    "How updates arrive. polling long-polls getUpdates (no public endpoint, needs an always-on " +
      "process). webhook registers public_url + path via setWebhook and serves inbound HTTP, so " +
      "the host can scale to zero between messages — Telegram queues undelivered updates (~24h) " +
      "and retries, which is what wakes the host back up.",
  ),
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
  port: z.number().int().min(1).max(65535).default(8080).describe(
    "webhook transport: port to listen on.",
  ),
  path: z.string().startsWith("/").default("/telegram").describe(
    "webhook transport: HTTP path Telegram POSTs updates to.",
  ),
  public_url: z.url().optional().describe(
    "webhook transport: the externally reachable HTTPS base registered via setWebhook " +
      "(e.g. https://my-agent.fly.dev). Required when transport is webhook.",
  ),
}).describe(
  "Listen to Telegram messages via Bot API long-polling (default, no public endpoint) or a " +
    "registered webhook (inbound HTTP, scale-to-zero friendly); replies go in-chat by default.",
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

const TtyTriggerSchema = z.strictObject({
  type: z.literal("tty"),
  path: z.string().startsWith("/").default("/tty").describe(
    "HTTP path that accepts the WebSocket upgrade.",
  ),
  port: z.number().int().min(1).max(65535).default(8090).describe("Port to listen on."),
  token_env: z.string().min(1).describe(
    "Env var holding the bearer token clients must present (authorization header, or the Sec-WebSocket-Protocol value `bearer.<token>` from browsers). Required: an unauthenticated terminal contradicts deny-by-default.",
  ),
}).describe(
  "Interactive terminal over WebSocket: connect to {path}, send {type: 'input', text} frames and receive the run's progress and result as JSON frames. This is the REPL as a network surface, for hosted terminals.",
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

const ImapEmailTriggerSchema = z.strictObject({
  type: z.literal("email"),
  transport: z.literal("imap").describe(
    "How mail arrives. imap is the pulled transport for an existing mailbox: the trigger polls the folder for unseen messages and replies over SMTP.",
  ),
  host: z.string().min(1).describe("IMAP server host, e.g. imap.fastmail.com."),
  port: z.number().int().min(1).max(65535).default(993).describe(
    "IMAP port (implicit TLS).",
  ),
  username: z.string().min(1).describe(
    "Mailbox login — also the address replies are sent from.",
  ),
  password_env: z.string().min(1).default("IMAP_PASSWORD").describe(
    "Env var holding the mailbox password (an app password where the provider requires one).",
  ),
  smtp_host: z.string().min(1).describe("SMTP server for replies, e.g. smtp.fastmail.com."),
  smtp_port: z.number().int().min(1).max(65535).default(465).describe(
    "SMTP port (implicit TLS).",
  ),
  folder: z.string().min(1).default("INBOX").describe(
    "Folder to watch. The unseen flag is the cursor — handled and dropped messages are marked seen — so give the agent a folder it owns.",
  ),
  poll_seconds: z.number().int().min(5).default(60).describe("Seconds between polls."),
  from_addresses: z.array(z.string().min(1)).min(1).describe(
    'Senders the agent handles: exact addresses or *@domain patterns. Required. ["*"] accepts anyone.',
  ),
  allow_silence: z.boolean().default(false).describe(
    "Send nothing when the agent replies with exactly __NO_REPLY__ (or nothing). Instruct the sentinel in purpose.",
  ),
}).describe(
  "Wake on unseen messages in an IMAP mailbox; replies go out over SMTP in the same thread.",
);

const GmailEmailTriggerSchema = z.strictObject({
  type: z.literal("email"),
  transport: z.literal("gmail").describe(
    "How mail arrives. gmail polls the Gmail API for unread messages in a label, authenticated by an OAuth refresh token.",
  ),
  client_id: z.string().min(1).describe(
    "OAuth client id of your Google Cloud project's Desktop-app client.",
  ),
  client_secret_env: z.string().min(1).default("GMAIL_CLIENT_SECRET").describe(
    "Env var holding the OAuth client secret.",
  ),
  refresh_token_env: z.string().min(1).default("GMAIL_REFRESH_TOKEN").describe(
    "Env var holding the refresh token from the one-time consent flow (docs/email.mdx documents it).",
  ),
  label: z.string().min(1).default("INBOX").describe(
    "Gmail label to watch. The unread state is the cursor — handled and dropped messages are marked read — so route mail here with Gmail filters and let the agent own the label.",
  ),
  poll_seconds: z.number().int().min(5).default(60).describe("Seconds between polls."),
  from_addresses: z.array(z.string().min(1)).min(1).describe(
    'Senders the agent handles: exact addresses or *@domain patterns. Required. ["*"] accepts anyone.',
  ),
  allow_silence: z.boolean().default(false).describe(
    "Send nothing when the agent replies with exactly __NO_REPLY__ (or nothing). Instruct the sentinel in purpose.",
  ),
}).describe(
  "Wake on unread Gmail messages in a label via the Gmail API; replies land in the same Gmail thread.",
);

const OutlookEmailTriggerSchema = z.strictObject({
  type: z.literal("email"),
  transport: z.literal("outlook").describe(
    "How mail arrives. outlook polls Microsoft Graph for unread messages in a folder, authenticated by an OAuth refresh token.",
  ),
  client_id: z.string().min(1).describe("Client id of your Entra app registration."),
  client_secret_env: z.string().min(1).optional().describe(
    "Env var holding the client secret — confidential clients only. Public (device-code) clients omit this.",
  ),
  refresh_token_env: z.string().min(1).default("OUTLOOK_REFRESH_TOKEN").describe(
    "Env var holding the refresh token from the one-time device-code flow (docs/email.mdx documents it).",
  ),
  tenant: z.string().min(1).default("common").describe(
    'Entra tenant: "common", "consumers", "organizations" or a tenant id.',
  ),
  folder: z.string().min(1).default("inbox").describe(
    "Mail folder to watch: a well-known name (inbox) or a folder id. The unread state is the cursor — handled and dropped messages are marked read.",
  ),
  poll_seconds: z.number().int().min(5).default(60).describe("Seconds between polls."),
  from_addresses: z.array(z.string().min(1)).min(1).describe(
    'Senders the agent handles: exact addresses or *@domain patterns. Required. ["*"] accepts anyone.',
  ),
  allow_silence: z.boolean().default(false).describe(
    "Send nothing when the agent replies with exactly __NO_REPLY__ (or nothing). Instruct the sentinel in purpose.",
  ),
}).describe(
  "Wake on unread Outlook messages in a folder via Microsoft Graph; replies land in the same conversation.",
);

const EmailTriggerSchema = z.discriminatedUnion("transport", [
  ResendEmailTriggerSchema,
  ImapEmailTriggerSchema,
  GmailEmailTriggerSchema,
  OutlookEmailTriggerSchema,
]).describe(
  "Wake on inbound email. transport picks how mail arrives: resend (pushed webhooks for the agent's own address), or imap / gmail / outlook (poll an existing mailbox).",
);

const GithubTriggerSchema = z.strictObject({
  type: z.literal("github"),
  path: z.string().startsWith("/").default("/github").describe(
    "HTTP path GitHub POSTs webhook deliveries to.",
  ),
  port: z.number().int().min(1).max(65535).default(8080).describe("Port to listen on."),
  secret_env: z.string().min(1).default("GITHUB_WEBHOOK_SECRET").describe(
    "Env var holding the webhook secret. Every delivery's X-Hub-Signature-256 is verified before parsing; unsigned POSTs get a 401.",
  ),
  events: z.array(z.string().min(1)).min(1).describe(
    'Events that wake the agent: an event name ("pull_request"), an event.action pair ("pull_request.opened"), or "*" for every event the webhook sends. Required — GitHub sends many event types down one hook.',
  ),
  repos: z.array(z.string().min(1)).optional().describe(
    "Repositories the agent handles: owner/repo or owner/* patterns. Omit to accept any repository the webhook covers (useful for org-level hooks).",
  ),
}).describe(
  "Wake on GitHub webhook events (pull requests, issues, pushes, releases and the rest). No reply channel: the agent acts through its permissions, typically the gh CLI.",
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
  TtyTriggerSchema,
  EmailTriggerSchema,
  GithubTriggerSchema,
  CronTriggerSchema,
]).describe("An event source that wakes the agent.");

const VoiceSttSchema = z.strictObject({
  provider: z.enum(["openai", "elevenlabs"]).describe(
    "Speech-to-text provider for incoming voice notes.",
  ),
  model: z.string().min(1).optional().describe(
    "Transcription model. Defaults per provider: gpt-4o-mini-transcribe (openai), scribe_v2 (elevenlabs).",
  ),
  api_key_env: z.string().min(1).optional().describe(
    "Name of the env var holding the API key — a reference, never a value. Defaults to OPENAI_API_KEY / ELEVENLABS_API_KEY per provider.",
  ),
  base_url: z.string().min(1).optional().describe(
    "Endpoint override for the openai provider, e.g. a metering gateway. Ignored by elevenlabs.",
  ),
}).describe("How incoming voice notes become text.");

const VoiceTtsSchema = z.strictObject({
  provider: z.enum(["openai", "elevenlabs"]).describe(
    "Text-to-speech provider for spoken replies.",
  ),
  model: z.string().min(1).optional().describe(
    "Speech model. Defaults per provider: gpt-4o-mini-tts (openai), eleven_multilingual_v2 (elevenlabs).",
  ),
  voice: z.string().min(1).optional().describe(
    "Voice to speak with: a voice name for openai (defaults to alloy), a voice id for elevenlabs (defaults to Rachel).",
  ),
  api_key_env: z.string().min(1).optional().describe(
    "Name of the env var holding the API key — a reference, never a value. Defaults to OPENAI_API_KEY / ELEVENLABS_API_KEY per provider.",
  ),
  base_url: z.string().min(1).optional().describe(
    "Endpoint override for the openai provider, e.g. a metering gateway. Ignored by elevenlabs.",
  ),
}).describe(
  "How replies to voice notes become speech. Omit this block and voice notes get text replies.",
);

const LiveVoiceSchema = z.strictObject({
  provider: z.literal("openai").describe(
    "Realtime speech-to-speech provider. openai is the only dialect today: the Realtime API now, " +
      "the gpt-live models the day their API opens.",
  ),
  model: z.string().min(1).default("gpt-realtime-2.1").describe(
    "Realtime model that holds the live conversation.",
  ),
  voice: z.string().min(1).default("marin").describe("Voice the session speaks with."),
  api_key_env: z.string().min(1).optional().describe(
    "Name of the env var holding the API key — a reference, never a value. Defaults to OPENAI_API_KEY.",
  ),
  idle_seconds: z.number().int().positive().default(60).describe(
    "Close the realtime session after this much silence; it reopens on the next voice activity. " +
      "Live sessions bill by the audio minute, so idle time is money.",
  ),
}).describe(
  "Live voice in Discord voice channels (plan 15): a realtime model holds the conversation and " +
    "delegates real work to the agent loop through a single tool. Pair with a discord trigger's " +
    "voice_channels.",
);

const VoiceConfigSchema = z.strictObject({
  stt: VoiceSttSchema.optional(),
  tts: VoiceTtsSchema.optional(),
  live: LiveVoiceSchema.optional(),
}).describe(
  "Voice on chat triggers. stt transcribes an incoming voice note (telegram, discord) and the " +
    "transcript runs through the normal text loop; with tts the reply comes back as a voice note " +
    "too. live holds spoken conversations in Discord voice channels. Omit the block and voice " +
    "notes are ignored.",
).superRefine((v, ctx) => {
  if (!v.stt && !v.tts && !v.live) {
    ctx.addIssue({ code: "custom", message: "an empty voice block configures nothing" });
  }
  if (v.tts && !v.stt) {
    ctx.addIssue({
      code: "custom",
      path: ["tts"],
      message: "voice.tts speaks replies to voice notes, which voice.stt transcribes — add stt",
    });
  }
});

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
    "Hosts http_request may reach; *.example.com matches subdomains (not the apex). A bare * " +
      "allows every host — the escape hatch for agents whose job is the open web, stated " +
      "loudly enough to catch in review.",
  ),
  run: z.array(z.string().min(1)).optional().describe(
    "Executables run_bash may spawn, matched by basename. run_bash exists only if this grants " +
      "something. A bare * allows every executable.",
  ),
  read: z.array(z.string().min(1)).optional().describe("Readable path prefixes."),
  write: z.array(z.string().min(1)).optional().describe("Writable path prefixes."),
}).describe(
  "Deny-by-default allowlists. Omitting this block means the agent can touch nothing; denials are surfaced to the model as tool results.",
);

const HttpAuthSchema = z.strictObject({
  url: z.string().min(1).describe(
    "URL prefix this credential applies to, e.g. https://api.stripe.com. The longest matching " +
      "prefix wins. The host must also be in permissions.net.",
  ),
  header: z.string().min(1).default("Authorization").describe(
    "Header to attach the credential as.",
  ),
  value: z.string().min(1).describe(
    "The header value, e.g. Bearer ${STRIPE_KEY}. ${VAR} references resolve at startup (env var, " +
      "then /run/secrets/<VAR>) and are redacted from every output surface.",
  ),
}).describe("One credential the runtime attaches to matching outbound requests.");

const HttpConfigSchema = z.strictObject({
  auth: z.array(HttpAuthSchema).optional().describe(
    "Credentials the runtime attaches to http_request calls, matched by URL prefix.",
  ),
}).describe(
  "Outbound HTTP the runtime handles on the agent's behalf. The model asks for a URL; the " +
    "credential is attached after the tool call, so it never passes through the model's context.",
);

const RedactConfigSchema = z.strictObject({
  headers: z.array(z.string().min(1)).optional().describe(
    "Extra header and field names whose value is scrubbed by name, on top of authorization, " +
      "cookie, x-api-key and the other usual suspects.",
  ),
  values: z.array(z.string().min(1)).optional().describe(
    "Extra ${VAR} references to scrub — a secret the agent reaches that this config does not " +
      "otherwise name, such as one baked into an MCP server's own image.",
  ),
}).describe(
  "Additions to the redaction the framework already does. Every secret the config references is " +
    "redacted without being listed here.",
);

const MemoryConfigSchema = z.strictObject({
  scope: z.enum(["thread", "none"]).default("none").describe(
    "thread: conversation history persists per conversation key (chat channel or thread, webhook conversation_id). none: every run starts fresh.",
  ),
  persistent: z.boolean().default(false).describe(
    "Give the agent remember/recall/list_memories/forget tools backed by its own SQLite file — " +
      "facts and preferences that survive across conversation keys and restarts, not just one thread's history.",
  ),
  compact_at_tokens: z.union([z.literal(false), z.number().int().positive()]).default(50_000)
    .describe(
      "Auto-compact a conversation once its context reaches this many tokens (the input tokens " +
        "the provider reported for the run's last LLM call). The older history is replaced by a " +
        "summary written via model.small; the most recent turns survive verbatim. false disables " +
        "auto-compaction; without scope: thread there is no history, so the threshold is inert.",
    ),
}).describe("What the agent remembers between events.");

const SchedulesConfigSchema = z.strictObject({
  max: z.number().int().positive().default(20).describe(
    "How many schedules may exist at once. The schedule tool refuses past the cap and tells " +
      "the model to unschedule something first, so an unattended agent cannot accumulate " +
      "unbounded future work.",
  ),
}).describe(
  "Let the agent schedule future runs of itself: a schedule/list_schedules/unschedule tool " +
    "trio backed by its own SQLite file. Schedules survive restarts, fire through the normal " +
    "run path, and deliver their result to the conversation that created them. Omit the block " +
    "and the tools do not exist.",
);

/** Built-in command names a config-defined command may not shadow. */
const RESERVED_COMMAND_NAMES = ["help", "status", "reset", "compact", "new", "stop"];

const CommandConfigSchema = z.strictObject({
  name: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]{0,31}$/,
      "command names are lowercase letters, digits, and underscores, max 32 chars (the strictest platform rules, so one name registers everywhere)",
    )
    .describe(
      "What operators type after the slash: /standup. Lowercase letters, digits, underscores, max 32 chars — valid on every chat platform.",
    ),
  description: z.string().min(3).max(100).describe(
    "One line shown by /help and in each platform's native command picker (platforms cap this around 100 chars).",
  ),
  prompt: z.string().min(1).describe(
    "The prompt the command runs through the normal agent loop. $ARGS is replaced with whatever follows the command name.",
  ),
}).describe("An operator-defined slash command: a named, repeatable prompt.");

const CommandsSchema = z
  .array(CommandConfigSchema)
  .superRefine((commands, ctx) => {
    const seen = new Set<string>();
    for (const [i, cmd] of commands.entries()) {
      if (RESERVED_COMMAND_NAMES.includes(cmd.name)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "name"],
          message: `"${cmd.name}" is a built-in command and cannot be redefined`,
        });
      }
      if (seen.has(cmd.name)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "name"],
          message: `duplicate command name "${cmd.name}"`,
        });
      }
      seen.add(cmd.name);
    }
  })
  .describe(
    "Operator-defined slash commands, alongside the built-ins /help, /status, /reset, /compact and /new.",
  );

const LimitsSchema = z.strictObject({
  max_steps: z.number().int().positive().default(20).describe(
    "Tool-calling iterations (LLM calls) per run. On hitting the cap the agent gets one final " +
      "tool-less call to summarize its progress, then the run ends with error_max_steps.",
  ),
  concurrent_runs: z.number().int().positive().default(4).describe(
    "Parallel runs across conversations. Within one conversation runs are always serial and " +
      "ordered, so each run sees what earlier messages did; this caps how many conversations " +
      "run at once. 1 serializes the whole agent.",
  ),
  queue_depth: z.number().int().nonnegative().default(10).describe(
    "Events that may wait per conversation while a run is in flight. An event past the cap is " +
      "refused immediately with a short reply, and every refusal lands in the audit trail.",
  ),
  max_image_bytes: z.number().int().positive().default(5_000_000).describe(
    "Largest image a channel may hand the model. A bigger one is named in the prompt and not " +
      "read, so the agent can say what arrived and why it didn't look at it.",
  ),
  max_images_per_message: z.number().int().nonnegative().default(4).describe(
    "Images one message may carry into the context. An image costs thousands of input tokens, " +
      "and a channel will happily deliver twenty. The rest are named and not read; 0 reads none.",
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
      "The operator's handle for this agent (compose service, logs, CLI, session keys). Unless `name` is set, the agent chooses its own name on first boot.",
    ),
  name: z.string().min(2).max(40).optional().describe(
    "Display name for the agent. When set, the agent skips the naming ritual and uses this name. Omit to let the agent choose its own name on first boot.",
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
  voice: VoiceConfigSchema.optional(),
  skills: z.array(z.string().min(1)).optional().describe(
    "Paths to skill markdown files (relative to this config). Skills carry knowledge, never capability.",
  ),
  tools: z
    .strictObject({
      mcp: z.array(McpServerSchema).optional().describe("MCP servers to connect at startup."),
      search: z.enum(["auto", "on", "off"]).default("auto").describe(
        "Tool search: defer MCP tool schemas out of context behind a search_tools tool. " +
          "auto defers when the agent has more than 10 tools; on always defers; off loads everything.",
      ),
    })
    .optional()
    .describe("Tool sources beyond the natives and skills."),
  commands: CommandsSchema.optional(),
  permissions: PermissionsSchema.optional(),
  env: z.record(z.string(), z.string()).optional().describe(
    "Secret env for tools and MCP servers. Values may be ${VAR} references, resolved at startup (env var, then /run/secrets/<VAR>) and scoped per tool. Everything here is treated as a secret and redacted from tool results, logs and traces — use `public` for configuration the agent must be able to read.",
  ),
  // Coerced, unlike `env`: this block holds ids, ports and regions, and YAML
  // reads a bare 12345 as a number. Quoting every project id would be a
  // papercut with nothing behind it — the value becomes a string either way.
  public: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()]).transform(String),
  ).optional().describe(
    "Non-secret env, scoped to tools exactly like `env` but never redacted. For configuration the agent has to see in its own output — a project id, an account number, a region. Redacting one of these scrubs it out of the URLs and responses the agent needs to read.",
  ),
  http: HttpConfigSchema.optional(),
  redact: RedactConfigSchema.optional(),
  memory: MemoryConfigSchema.optional(),
  schedules: SchedulesConfigSchema.optional(),
  limits: LimitsSchema.default({
    max_steps: 20,
    concurrent_runs: 4,
    queue_depth: 10,
    max_image_bytes: 5_000_000,
    max_images_per_message: 4,
  }),
}).describe(
  "A Looped AF agent: one job, one file. https://github.com/loopedautomation/agent-framework",
).superRefine((config, ctx) => {
  // voice_channels without voice.live would join a channel and sit mute — the
  // kind of silent no-op this schema treats as an error everywhere else.
  (config.triggers ?? []).forEach((t, i) => {
    if (t.type === "discord" && t.voice_channels?.length && !config.voice?.live) {
      ctx.addIssue({
        code: "custom",
        path: ["triggers", i, "voice_channels"],
        message: "voice_channels requires the top-level voice.live block",
      });
    }
    if (t.type === "telegram") {
      // setWebhook needs somewhere to deliver to, and Telegram only accepts
      // HTTPS; a polling trigger with a public_url would silently never use it.
      if (t.transport === "webhook" && !t.public_url) {
        ctx.addIssue({
          code: "custom",
          path: ["triggers", i, "public_url"],
          message: "the webhook transport requires public_url (registered via setWebhook)",
        });
      }
      if (t.public_url && !t.public_url.startsWith("https://")) {
        ctx.addIssue({
          code: "custom",
          path: ["triggers", i, "public_url"],
          message: "public_url must be https:// — Telegram only delivers webhooks over HTTPS",
        });
      }
      if (t.transport !== "webhook" && t.public_url) {
        ctx.addIssue({
          code: "custom",
          path: ["triggers", i, "public_url"],
          message: "public_url only applies to the webhook transport",
        });
      }
    }
  });
});

// The exported types below are written out by hand so the public API carries
// explicit types (JSR's no-slow-types rule; z.infer of a schema is not one).
// The _sync checks at the bottom of this file fail to compile if a type
// drifts from its schema, so the two cannot diverge silently.

/** The `model` block of an agent config: which model runs the agent, and how to reach it. */
export interface ModelConfig {
  /**
   * LLM provider dialect. openai-compatible covers OpenAI, Ollama, vLLM and compatible proxies;
   * gemini is the native Gemini API; codex uses an OpenAI Codex (ChatGPT) subscription via the
   * credentials from `codex login`.
   */
  provider: "openai-compatible" | "anthropic" | "gemini" | "codex";
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
  /** Post nothing when the agent replies with __NO_REPLY__ (punctuation/whitespace tolerated) or nothing. */
  allow_silence: boolean;
  /** Show the typing indicator in the source channel while the agent works. */
  show_typing: boolean;
  /** Voice channel names or ids to join for live spoken conversations; requires voice.live. */
  voice_channels?: string[];
}

/** A Slack trigger: listen to messages via Socket Mode or the Events API. */
export interface SlackTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "slack";
  /** How events arrive: a Socket Mode connection (default) or inbound Events API HTTP. */
  transport: "socket" | "events_api";
  /** Channel names or ids to listen in; omit for all channels the bot is in. */
  channels?: string[];
  /** Only respond when the bot is @-mentioned. DMs always address the bot. */
  require_mention?: boolean;
  /** Env var holding the bot token (xoxb-…). */
  token_env: string;
  /** Env var holding the app-level token (xapp-…); only the socket transport needs it. */
  app_token_env: string;
  /** events_api transport: port to listen on. */
  port: number;
  /** events_api transport: HTTP path Slack POSTs event deliveries to. */
  path: string;
  /** events_api transport: env var holding the app's signing secret. */
  signing_secret_env: string;
  /** Only handle messages from these Slack user ids (U…). */
  from_users?: string[];
  /** Channel id to post replies into instead of the source thread. */
  reply_channel?: string;
  /** Post nothing when the agent replies with exactly __NO_REPLY__ (or nothing). */
  allow_silence: boolean;
}

/** A Telegram trigger: listen to messages via Bot API long-polling or a registered webhook. */
export interface TelegramTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "telegram";
  /** How updates arrive: getUpdates long-polling (default) or an inbound webhook. */
  transport: "polling" | "webhook";
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
  /** webhook transport: port to listen on. */
  port: number;
  /** webhook transport: HTTP path Telegram POSTs updates to. */
  path: string;
  /** webhook transport: the externally reachable HTTPS base registered via setWebhook. */
  public_url?: string;
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

/** A tty trigger: an interactive terminal session over WebSocket — the REPL as a network surface. */
export interface TtyTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "tty";
  /** HTTP path that accepts the WebSocket upgrade. */
  path: string;
  /** Port to listen on. */
  port: number;
  /** Env var holding the bearer token clients must present. */
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

/** An email trigger on the IMAP pulled transport: poll an existing mailbox, reply over SMTP. */
export interface ImapEmailTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "email";
  /** Discriminant for EmailTriggerConfig: how mail arrives. */
  transport: "imap";
  /** IMAP server host. */
  host: string;
  /** IMAP port (implicit TLS). */
  port: number;
  /** Mailbox login — also the address replies are sent from. */
  username: string;
  /** Env var holding the mailbox password. */
  password_env: string;
  /** SMTP server for replies. */
  smtp_host: string;
  /** SMTP port (implicit TLS). */
  smtp_port: number;
  /** Folder to watch; the unseen flag is the cursor. */
  folder: string;
  /** Seconds between polls. */
  poll_seconds: number;
  /** Senders the agent handles: exact addresses, `*@domain` patterns, or `*` for anyone. */
  from_addresses: string[];
  /** Send nothing when the agent replies with exactly __NO_REPLY__ (or nothing). */
  allow_silence: boolean;
}

/** An email trigger polling the Gmail API for unread messages in a label. */
export interface GmailEmailTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "email";
  /** Discriminant for EmailTriggerConfig: how mail arrives. */
  transport: "gmail";
  /** OAuth client id of the Google Cloud Desktop-app client. */
  client_id: string;
  /** Env var holding the OAuth client secret. */
  client_secret_env: string;
  /** Env var holding the refresh token from the one-time consent flow. */
  refresh_token_env: string;
  /** Gmail label to watch; the unread state is the cursor. */
  label: string;
  /** Seconds between polls. */
  poll_seconds: number;
  /** Senders the agent handles: exact addresses, `*@domain` patterns, or `*` for anyone. */
  from_addresses: string[];
  /** Send nothing when the agent replies with exactly __NO_REPLY__ (or nothing). */
  allow_silence: boolean;
}

/** An email trigger polling Microsoft Graph for unread messages in a folder. */
export interface OutlookEmailTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "email";
  /** Discriminant for EmailTriggerConfig: how mail arrives. */
  transport: "outlook";
  /** Client id of the Entra app registration. */
  client_id: string;
  /** Env var holding the client secret — confidential clients only. */
  client_secret_env?: string;
  /** Env var holding the refresh token from the one-time device-code flow. */
  refresh_token_env: string;
  /** Entra tenant: "common", "consumers", "organizations" or a tenant id. */
  tenant: string;
  /** Mail folder to watch; the unread state is the cursor. */
  folder: string;
  /** Seconds between polls. */
  poll_seconds: number;
  /** Senders the agent handles: exact addresses, `*@domain` patterns, or `*` for anyone. */
  from_addresses: string[];
  /** Send nothing when the agent replies with exactly __NO_REPLY__ (or nothing). */
  allow_silence: boolean;
}

/** An email trigger, discriminated on `transport`. */
export type EmailTriggerConfig =
  | ResendEmailTriggerConfig
  | ImapEmailTriggerConfig
  | GmailEmailTriggerConfig
  | OutlookEmailTriggerConfig;

/** A cron trigger: fire the agent on a schedule with a fixed prompt. */
export interface CronTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "cron";
  /** Cron expression, e.g. "0 9 * * 1" for Mondays 09:00. */
  schedule: string;
  /** What to tell the agent each tick. */
  prompt: string;
}

/** A GitHub trigger: repository or organization webhook deliveries wake the agent. */
export interface GithubTriggerConfig {
  /** Discriminant for TriggerConfig. */
  type: "github";
  /** HTTP path GitHub POSTs webhook deliveries to. */
  path: string;
  /** Port to listen on. */
  port: number;
  /** Env var holding the webhook secret; every delivery's signature is verified. */
  secret_env: string;
  /** Events that wake the agent: "pull_request", "pull_request.opened", or "*". */
  events: string[];
  /** Repositories the agent handles: owner/repo or owner/* patterns. Omit for all. */
  repos?: string[];
}

/** An event source that wakes the agent, discriminated on `type`. */
export type TriggerConfig =
  | DiscordTriggerConfig
  | SlackTriggerConfig
  | TelegramTriggerConfig
  | WebhookTriggerConfig
  | TtyTriggerConfig
  | EmailTriggerConfig
  | GithubTriggerConfig
  | CronTriggerConfig;

/** How incoming voice notes become text. */
export interface VoiceSttConfig {
  /** Speech-to-text provider. */
  provider: "openai" | "elevenlabs";
  /** Transcription model. Defaults per provider: gpt-4o-mini-transcribe (openai), scribe_v2 (elevenlabs). */
  model?: string;
  /** Name of the env var holding the API key. Defaults to OPENAI_API_KEY / ELEVENLABS_API_KEY per provider. */
  api_key_env?: string;
  /** Endpoint override for the openai provider, e.g. a metering gateway. Ignored by elevenlabs. */
  base_url?: string;
}

/** How replies to voice notes become speech. */
export interface VoiceTtsConfig {
  /** Text-to-speech provider. */
  provider: "openai" | "elevenlabs";
  /** Speech model. Defaults per provider: gpt-4o-mini-tts (openai), eleven_multilingual_v2 (elevenlabs). */
  model?: string;
  /** Voice to speak with: a voice name for openai (defaults to alloy), a voice id for elevenlabs (defaults to Rachel). */
  voice?: string;
  /** Name of the env var holding the API key. Defaults to OPENAI_API_KEY / ELEVENLABS_API_KEY per provider. */
  api_key_env?: string;
  /** Endpoint override for the openai provider, e.g. a metering gateway. Ignored by elevenlabs. */
  base_url?: string;
}

/** Live voice in Discord voice channels: the realtime model and its budget (plan 15). */
export interface LiveVoiceConfig {
  /** Realtime speech-to-speech provider; openai is the only dialect today. */
  provider: "openai";
  /** Realtime model that holds the live conversation. */
  model: string;
  /** Voice the session speaks with. */
  voice: string;
  /** Name of the env var holding the API key. Defaults to OPENAI_API_KEY. */
  api_key_env?: string;
  /** Close the realtime session after this much silence; it reopens on the next voice activity. */
  idle_seconds: number;
}

/** Voice on chat triggers: stt transcribes voice notes, tts speaks replies, live holds conversations. */
export interface VoiceConfig {
  /** How incoming voice notes become text. */
  stt?: VoiceSttConfig;
  /** How replies become speech. Omit and voice notes get text replies. */
  tts?: VoiceTtsConfig;
  /** Live voice in Discord voice channels. */
  live?: LiveVoiceConfig;
}

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

/** An operator-defined slash command: a named, repeatable prompt. */
export interface CommandConfig {
  /** What operators type after the slash: /standup. Lowercase letters, digits, underscores, max 32 chars. */
  name: string;
  /** One line shown by /help and in each platform's native command picker. */
  description: string;
  /** The prompt the command runs through the normal agent loop; $ARGS is replaced with the trailing text. */
  prompt: string;
}

/** Deny-by-default allowlists. Omitting a list means the agent can touch nothing on that axis. */
export interface Permissions {
  /** Hosts http_request may reach; *.example.com matches subdomains; a bare * allows every host. */
  net?: string[];
  /** Executables run_bash may spawn, matched by basename; a bare * allows every executable. */
  run?: string[];
  /** Readable path prefixes. */
  read?: string[];
  /** Writable path prefixes. */
  write?: string[];
}

/** One credential the runtime attaches to matching outbound requests. */
export interface HttpAuthConfig {
  /** URL prefix this credential applies to; the longest matching prefix wins. */
  url: string;
  /** Header to attach the credential as. */
  header: string;
  /** The header value, e.g. `Bearer ${STRIPE_KEY}`; ${VAR} references resolve at startup. */
  value: string;
}

/** Outbound HTTP the runtime handles on the agent's behalf. */
export interface HttpConfig {
  /** Credentials attached to http_request calls, matched by URL prefix. */
  auth?: HttpAuthConfig[];
}

/** Additions to the redaction the framework already does. */
export interface RedactConfig {
  /** Extra header and field names whose value is scrubbed by name. */
  headers?: string[];
  /** Extra ${VAR} references to scrub. */
  values?: string[];
}

/** What the agent remembers between events. */
export interface MemoryConfig {
  /** thread: conversation history persists per conversation key. none: every run starts fresh. */
  scope: "thread" | "none";
  /** Give the agent remember/recall/list_memories/forget tools, backed by its own SQLite file. */
  persistent: boolean;
  /**
   * Auto-compact a conversation once its context reaches this many tokens (the input tokens the
   * provider reported for the run's last LLM call). The older history is replaced by a summary
   * written via model.small; the most recent turns survive verbatim. false disables
   * auto-compaction; without scope: thread there is no history, so the threshold is inert.
   */
  compact_at_tokens: number | false;
}

/** Agent-created schedules: the schedule/list_schedules/unschedule tools. */
export interface SchedulesConfig {
  /**
   * How many schedules may exist at once. The schedule tool refuses past the cap and tells the
   * model to unschedule something first.
   */
  max: number;
}

/** Per-run budgets. */
export interface LimitsConfig {
  /**
   * Tool-calling iterations (LLM calls) per run. On hitting the cap the agent gets one final
   * tool-less call to summarize its progress, then the run ends with error_max_steps.
   */
  max_steps: number;
  /**
   * Parallel runs across conversations. Within one conversation runs are always serial and
   * ordered; this caps how many conversations run at once. 1 serializes the whole agent.
   */
  concurrent_runs: number;
  /**
   * Events that may wait per conversation while a run is in flight. An event past the cap is
   * refused immediately with a short reply, and every refusal lands in the audit trail.
   */
  queue_depth: number;
  /**
   * Largest image a channel may hand the model. A bigger one is named in the prompt and not read.
   */
  max_image_bytes: number;
  /**
   * Images one message may carry into the context. The rest are named and not read; 0 reads none.
   */
  max_images_per_message: number;
}

/** A parsed and validated agent.yaml, with defaults applied. */
export interface AgentConfig {
  /** The operator's handle for this agent (compose service, logs, CLI, session keys). */
  handle: string;
  /** Operator-set display name. When present, the naming ritual is skipped. */
  name?: string;
  /** One line: what job this agent does. */
  description: string;
  /** Which model runs this agent, and how to reach it. */
  model: ModelConfig;
  /** The agent's job description; becomes the model's system prompt. */
  purpose: string;
  /** Event sources that wake the agent. */
  triggers?: TriggerConfig[];
  /** Voice notes on chat triggers: stt transcribes them in; tts speaks the replies back. */
  voice?: VoiceConfig;
  /** Paths to skill markdown files, relative to this config. */
  skills?: string[];
  /** Tool sources beyond the natives and skills. */
  tools?: {
    /** MCP servers to connect at startup. */
    mcp?: McpServerConfig[];
    /** Tool search: defer MCP tool schemas out of context behind a search_tools tool. */
    search: "auto" | "on" | "off";
  };
  /** Operator-defined slash commands, alongside the built-ins /help, /status, /reset, /compact and /new. */
  commands?: CommandConfig[];
  /** Deny-by-default permission allowlists. */
  permissions?: Permissions;
  /**
   * Secret env for tools and MCP servers; values may be ${VAR} references.
   * Everything here is a secret by definition and is redacted on the way out —
   * that coupling is why {@linkcode AgentConfig.public} exists.
   */
  env?: Record<string, string>;
  /** Non-secret env, scoped like `env` but never redacted: configuration the agent must be able to read. */
  public?: Record<string, string>;
  /** Credentials the runtime attaches to outbound requests, so the model never holds them. */
  http?: HttpConfig;
  /** Additions to the redaction the framework already does. */
  redact?: RedactConfig;
  /** What the agent remembers between events. */
  memory?: MemoryConfig;
  /** Agent-created schedules: the schedule/list_schedules/unschedule tools. Omit = no tools. */
  schedules?: SchedulesConfig;
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
  gemini: "GEMINI_API_KEY",
};

/** The env var each voice provider reads its API key from when api_key_env is omitted. */
export const DEFAULT_VOICE_API_KEY_ENV: Record<VoiceSttConfig["provider"], string> = {
  openai: "OPENAI_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
};

// Compile-time drift guards: each fails if the hand-written type and the
// schema's inferred type stop being mutually assignable.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _agentConfigInSync: MutuallyAssignable<AgentConfig, z.infer<typeof agentConfigSchema>> = true;
const _triggerConfigInSync: MutuallyAssignable<TriggerConfig, z.infer<typeof TriggerSchema>> = true;
const _permissionsInSync: MutuallyAssignable<Permissions, z.infer<typeof PermissionsSchema>> = true;
const _httpInSync: MutuallyAssignable<HttpConfig, z.infer<typeof HttpConfigSchema>> = true;
const _redactInSync: MutuallyAssignable<RedactConfig, z.infer<typeof RedactConfigSchema>> = true;
const _voiceInSync: MutuallyAssignable<VoiceConfig, z.infer<typeof VoiceConfigSchema>> = true;

/** The published JSON Schema for agent.yaml (editor completion, validation). */
export function agentConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(agentConfigSchema, { io: "input" }) as Record<
    string,
    unknown
  >;
}
