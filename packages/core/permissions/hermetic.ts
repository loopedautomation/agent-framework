import type { AgentConfig, McpServerConfig, ModelConfig, TriggerConfig } from "../config/schema.ts";

/**
 * Hermetic mode: the Deno sandbox holds the whole net allowlist.
 *
 * `permissions.net` gates the native http_request tool, and nothing else. A
 * bash subprocess or a stdio MCP server makes whatever outbound call it wants,
 * because the runtime is launched with `--allow-net` open and the engine never
 * sees traffic it didn't originate (Plan 6, gap 1).
 *
 * The escape hatch only exists when the config asks for it. An agent with no
 * `permissions.run` grants and no stdio MCP servers spawns nothing, so every
 * byte it sends leaves through the Deno runtime — and the runtime's own
 * `--allow-net` can hold the entire allowlist, HTTP MCP clients and provider
 * SDKs included. Such an agent qualifies for hermetic mode: the entrypoint
 * re-execs itself with narrow flags before it connects anything outward.
 *
 * The allowlist has to cover the framework's own traffic, all of which is
 * derivable from the config: the model endpoint, each trigger's hosts, HTTP MCP
 * URLs, and listen rights for the status server and webhook ports.
 */

/** How the environment is read; injectable so the planner is testable. */
export type Env = (key: string) => string | undefined;

/** A resolved decision about running one agent under a narrowed Deno sandbox. */
export interface HermeticPlan {
  /** Whether the agent can run with its net allowlist enforced by Deno. */
  eligible: boolean;
  /** Why not, one line per disqualifying grant. Empty when eligible. */
  blockers: string[];
  /** The Deno flags to run under: narrowed when eligible, the image's when not. */
  flags: string[];
  /** The derived net allowlist — every host the agent may reach or listen on. */
  hosts: string[];
}

/**
 * Read paths the runtime needs whatever the agent declares: its config, its
 * skills, the source, the module cache, and the secrets dir env refs resolve
 * against. Mirrors the ENTRYPOINT in images/agent/Dockerfile — hermetic mode
 * replaces those flags, so it has to carry what they carried. A test asserts
 * the two lists stay identical.
 */
export const RUNTIME_READ_PATHS: string[] = [
  "/agent",
  "/skills",
  "/data",
  "/looped",
  "/deno-dir",
  "/run/secrets",
];

/** Write paths the runtime needs: the data volume, where identity and memory live. */
export const RUNTIME_WRITE_PATHS: string[] = ["/data"];

/**
 * The image's fixed flags — what a non-qualifying agent actually runs under.
 * Net is open here; for that agent class the container is the egress boundary.
 */
export const IMAGE_FLAGS: string[] = [
  "--allow-env",
  `--allow-read=${RUNTIME_READ_PATHS.join(",")}`,
  `--allow-write=${RUNTIME_WRITE_PATHS.join(",")}`,
  "--allow-net",
  "--allow-run=bash,deno",
];

/**
 * The image's environment, for describing a container from outside it (`af
 * flags`, `af validate`): the status server binds every interface in there, not
 * loopback. Mirrors the ENV block in images/agent/Dockerfile.
 */
export const IMAGE_ENV: Env = (key) => (key === "AF_STATUS_HOST" ? "0.0.0.0" : undefined);

/** Default endpoints per provider, from packages/core/providers/. */
const PROVIDER_HOSTS: Record<ModelConfig["provider"], string[]> = {
  "openai-compatible": ["api.openai.com"],
  "anthropic": ["api.anthropic.com"],
  // codex authenticates against the OAuth endpoint, then calls the backend.
  "codex": ["auth.openai.com", "chatgpt.com"],
};

/** The host (with port, when non-default) a URL is reached at. */
function urlHost(url: string): string {
  const u = new URL(url);
  return u.port ? `${u.hostname}:${u.port}` : u.hostname;
}

function modelHosts(model: ModelConfig): string[] {
  if (model.base_url) return [urlHost(model.base_url)];
  return PROVIDER_HOSTS[model.provider];
}

/**
 * The hosts one trigger reaches, and the addresses it listens on. Kept beside
 * the eligibility check rather than in each trigger, because core cannot import
 * the triggers package; the trigger tests assert the same endpoints.
 */
function triggerHosts(trigger: TriggerConfig, listenHost: string): string[] {
  switch (trigger.type) {
    case "discord":
      // REST API, plus the gateway socket /gateway/bot hands back.
      return ["discord.com", "gateway.discord.gg"];
    case "slack":
      // Web API, plus Socket Mode's two published websocket endpoints.
      return ["slack.com", "wss-primary.slack.com", "wss-backup.slack.com"];
    case "telegram":
      return ["api.telegram.org"];
    case "webhook":
    case "github":
      return [`${listenHost}:${trigger.port}`];
    case "cron":
      return [];
    case "email":
      switch (trigger.transport) {
        case "resend":
          return ["api.resend.com", `${listenHost}:${trigger.port}`];
        case "imap":
          // Raw TLS sockets, not fetch — the ports are part of the descriptor.
          return [
            `${trigger.host}:${trigger.port}`,
            `${trigger.smtp_host}:${trigger.smtp_port}`,
          ];
        case "gmail":
          return ["gmail.googleapis.com", "oauth2.googleapis.com"];
        case "outlook":
          return ["graph.microsoft.com", "login.microsoftonline.com"];
      }
  }
  // A trigger type with no host derivation is a hole in the allowlist, and a
  // hermetic agent would fail at connect time. Fail here, at startup, instead.
  throw new Error(`no hermetic host derivation for trigger: ${(trigger as { type: string }).type}`);
}

/**
 * Deno's `--allow-net` speaks in exact hosts and `*.example.com` wildcards
 * (verified on Deno 2.9, the image's pin), so every pattern `permissions.net`
 * can hold compiles. One nuance carries over from Deno's matcher: its wildcard
 * covers the apex as well as the subdomains, so at this layer `*.example.com`
 * reaches `example.com` too. The engine's own per-call matching still reserves
 * the apex for an explicit entry, and a sandbox one host wide of the config
 * beats keeping the whole net open.
 */
export function denoNetHosts(
  patterns: string[] | undefined,
): { hosts: string[]; open: boolean } {
  const hosts: string[] = [];
  let open = false;
  for (const p of patterns ?? []) {
    if (p === "*") open = true;
    else hosts.push(p);
  }
  return { hosts, open };
}

/** Every host the agent itself needs, derived from the config it declares. */
export function derivedHosts(config: AgentConfig, env: Env = Deno.env.get): string[] {
  const listenHost = env("AF_STATUS_HOST") ?? "127.0.0.1";
  const statusPort = env("AF_STATUS_PORT") ?? "9090";
  const hosts = [
    `${listenHost}:${statusPort}`,
    ...modelHosts(config.model),
    ...(config.triggers ?? []).flatMap((t) => triggerHosts(t, listenHost)),
    ...(config.tools?.mcp ?? []).filter((s) => s.url).map((s) => urlHost(s.url!)),
  ];
  return [...new Set(hosts)];
}

/** Whether an MCP server runs as a subprocess (stdio) rather than over HTTP. */
function isStdio(server: McpServerConfig): boolean {
  return server.command !== undefined;
}

/**
 * Decide whether this agent can have its net allowlist enforced by Deno, and
 * compile the flags it runs under either way.
 *
 * `extraRead` carries the directories this particular process needs to read but
 * cannot name in advance: the config's own directory, the source root. In the
 * image they land inside {@linkcode RUNTIME_READ_PATHS} anyway; outside it
 * (AF_CONTAINER=1 against a checkout) they're what keeps the narrowed sandbox
 * able to read the agent it was pointed at.
 */
export function hermeticPlan(
  config: AgentConfig,
  env: Env = Deno.env.get,
  extraRead: string[] = [],
): HermeticPlan {
  const blockers: string[] = [];

  const run = config.permissions?.run ?? [];
  if (run.length) {
    blockers.push(
      `permissions.run grants ${run.join(", ")} — a subprocess leaves the Deno sandbox`,
    );
  }
  for (const server of (config.tools?.mcp ?? []).filter(isStdio)) {
    blockers.push(`MCP server "${server.name}" is stdio — it runs as a subprocess`);
  }

  const net = denoNetHosts(config.permissions?.net);
  const hosts = [...new Set([...derivedHosts(config, env), ...net.hosts])];
  if (blockers.length) return { eligible: false, blockers, flags: IMAGE_FLAGS, hosts };

  const dataDir = env("AF_DATA_DIR");
  const denoDir = env("DENO_DIR");
  const runtime = [...RUNTIME_READ_PATHS, dataDir, denoDir, ...extraRead].filter((p) =>
    p !== undefined
  );
  const read = [...new Set([...runtime, ...(config.permissions?.read ?? [])])];
  const write = [
    ...new Set([...RUNTIME_WRITE_PATHS, dataDir, ...(config.permissions?.write ?? [])]
      .filter((p) => p !== undefined)),
  ];
  const flags = [
    "--allow-env",
    `--allow-read=${read.join(",")}`,
    `--allow-write=${write.join(",")}`,
    // An agent that declares net: ["*"] asked for the open web; the sandbox
    // still narrows everything else, and no subprocess can widen it.
    net.open ? "--allow-net" : `--allow-net=${hosts.join(",")}`,
  ];
  return { eligible: true, blockers, flags, hosts };
}
