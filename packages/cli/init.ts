// af init — scaffold an agent project: the agent file, its secrets template,
// and the chosen deployment shape. Pure generation here; prompting/writing in
// main.ts. Principle (#19): no scaffold may require hand-managing files on a
// server — files live in git or on your laptop, or nowhere (env-var deploy).

export const TRIGGERS = ["discord", "slack", "telegram", "webhook", "cron", "none"] as const;
export const PROVIDERS = ["openai-compatible", "anthropic", "gemini", "codex", "local"] as const;
export const DEPLOYS = [
  "local",
  "docker",
  "compose",
  "compose-inline",
  "paas-git",
  "paas-env",
] as const;

export interface InitOptions {
  handle: string;
  trigger: (typeof TRIGGERS)[number];
  provider: (typeof PROVIDERS)[number];
  /** Model id; sensible default per provider. */
  model?: string;
  /** Executables the agent needs (adds a Dockerfile layer + run permissions). */
  clis: string[];
  deploy: (typeof DEPLOYS)[number];
}

const MODELINE = "# yaml-language-server: $schema=https://looped.sh/schema/agent.json";
const IMAGE = "ghcr.io/loopedautomation/agent:latest";

const DEFAULT_MODELS: Record<InitOptions["provider"], string> = {
  "openai-compatible": "gpt-5.4-mini",
  anthropic: "claude-sonnet-5",
  gemini: "gemini-3.6-flash",
  codex: "gpt-5-codex",
  local: "llama3.1",
};

function keyEnv(provider: InitOptions["provider"]): string | undefined {
  if (provider === "openai-compatible") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "gemini") return "GEMINI_API_KEY";
  return undefined; // local endpoints need no key; codex uses `codex login` credentials
}

function agentYaml(o: InitOptions): string {
  const lines: string[] = [
    MODELINE,
    `handle: ${o.handle} # what you call it — the agent names itself on first boot`,
    `description: TODO one line — what job does this agent do?`,
    "",
    "model:",
    `  provider: ${o.provider === "local" ? "openai-compatible" : o.provider}`,
    `  id: ${o.model ?? DEFAULT_MODELS[o.provider]}`,
  ];
  if (o.provider === "local") lines.push("  base_url: http://localhost:11434/v1 # Ollama");
  lines.push(
    "",
    "purpose: |",
    "  TODO the job description. What should this agent do, how should it",
    "  behave, and when should it stay quiet? Be specific — this is the",
    "  entire brief the model works from.",
  );

  switch (o.trigger) {
    case "discord":
      lines.push(
        "",
        "triggers:",
        "  - type: discord",
        '    channels: ["general"] # TODO the channels to listen in',
        "    # token_env: DISCORD_BOT_TOKEN (default)",
      );
      break;
    case "slack":
      lines.push(
        "",
        "triggers:",
        "  - type: slack",
        '    channels: ["general"] # TODO the channels to listen in',
        "    # token_env: SLACK_BOT_TOKEN (default)",
        "    # app_token_env: SLACK_APP_TOKEN (default)",
      );
      break;
    case "telegram":
      lines.push(
        "",
        "triggers:",
        "  - type: telegram",
        '    # chats: ["-100123"] # TODO chat ids or group titles; omit for all',
        "    # token_env: TELEGRAM_BOT_TOKEN (default)",
      );
      break;
    case "webhook":
      lines.push(
        "",
        "triggers:",
        "  - type: webhook",
        "    token_env: WEBHOOK_TOKEN",
      );
      break;
    case "cron":
      lines.push(
        "",
        "triggers:",
        "  - type: cron",
        '    schedule: "0 9 * * 1" # TODO when to fire',
        "    prompt: TODO what to tell the agent each tick",
      );
      break;
    case "none":
      break;
  }

  if (o.clis.length) {
    lines.push(
      "",
      "permissions:",
      `  run: [${o.clis.join(", ")}] # the Dockerfile installs these`,
    );
  }
  if (["discord", "slack", "telegram", "webhook"].includes(o.trigger)) {
    lines.push("", "memory:", "  scope: thread");
  }
  return lines.join("\n") + "\n";
}

function envExample(o: InitOptions): string {
  const vars: string[] = [];
  const key = keyEnv(o.provider);
  if (key) vars.push(`${key}=`);
  if (o.provider === "codex") {
    vars.push("# codex: no API key — authenticates via ~/.codex/auth.json (run `codex login`)");
  }
  if (o.trigger === "discord") vars.push("DISCORD_BOT_TOKEN=");
  if (o.trigger === "slack") vars.push("SLACK_BOT_TOKEN=", "SLACK_APP_TOKEN=");
  if (o.trigger === "telegram") vars.push("TELEGRAM_BOT_TOKEN=");
  if (o.trigger === "webhook") vars.push("WEBHOOK_TOKEN=");
  return "# Copy to .env and fill in. Never commit .env.\n" + vars.join("\n") + "\n";
}

function dockerfile(o: InitOptions): string {
  const lines = [`FROM ${IMAGE}`, ""];
  if (o.clis.length) {
    lines.push("USER root", `RUN apk add --no-cache ${o.clis.join(" ")}`, "USER looped", "");
  }
  lines.push(
    "# Bake the config in: a self-contained artifact that deploys anywhere.",
    "COPY --chown=looped:looped agent.yaml /agent/agent.yaml",
  );
  return lines.join("\n") + "\n";
}

function composeInlineYaml(o: InitOptions): string {
  // The whole agent — config and deployment — in one compose file. The config
  // is a top-level `configs:` element mounted at /agent/agent.yaml, keeping
  // configuration out of the environment (inline `content:` needs Docker
  // Compose v2.23.1+). The embedded YAML is a block scalar; drop the modeline
  // (editors don't validate inside a string) and indent to sit under the key.
  const embedded = agentYaml(o)
    .split("\n")
    .slice(1) // modeline
    .map((line) => (line ? `      ${line}` : ""))
    .join("\n")
    .trimEnd();
  const lines = [
    "# One file: the agent's config is defined below and mounted in — no agent.yaml needed.",
    "# Requires Docker Compose v2.23.1+ (inline `content:`).",
    "# NOTE: env references inside the config must be written $${VAR} (double",
    "# dollar) so compose passes them through for the runtime to resolve.",
    "configs:",
    "  agent-yaml:",
    "    content: |",
    embedded,
    "",
    "services:",
    `  ${o.handle}:`,
    `    image: ${IMAGE}`,
    "    configs:",
    "      - source: agent-yaml",
    "        target: /agent/agent.yaml",
    "    env_file: .env",
    "    volumes:",
    `      - ${o.handle}-data:/data # the agent's memory and name live here`,
    ...(o.provider === "codex"
      ? ["      - ~/.codex:/home/looped/.codex # `codex login` credentials"]
      : []),
  ];
  const ports = [
    "      # Status surface: curl localhost:9090/healthz",
    '      - "127.0.0.1:9090:9090"',
  ];
  if (o.trigger === "webhook") ports.unshift('      - "8080:8080" # webhook trigger');
  lines.push("    ports:", ...ports);
  lines.push(
    "    restart: unless-stopped",
    "    read_only: true",
    "    tmpfs:",
    "      - /tmp",
    "",
    "volumes:",
    `  ${o.handle}-data:`,
  );
  return lines.join("\n") + "\n";
}

function composeYaml(o: InitOptions, withBuild: boolean): string {
  const lines = ["services:", `  ${o.handle}:`];
  // docker compose derives an implicit image name from the service name when
  // `build:` has no `image:` alongside it, and won't lowercase that for us —
  // an uppercase handle would produce an invalid tag. Pin one explicitly.
  lines.push(
    withBuild ? `    build: .\n    image: ${o.handle.toLowerCase()}` : `    image: ${IMAGE}`,
  );
  if (!withBuild) lines.push("    volumes:", "      - ./agent.yaml:/agent/agent.yaml:ro");
  lines.push("    env_file: .env");
  if (withBuild) lines.push("    volumes:");
  lines.push(`      - ${o.handle}-data:/data # the agent's memory and name live here`);
  if (o.provider === "codex") {
    lines.push("      - ~/.codex:/home/looped/.codex # `codex login` credentials");
  }
  const ports = [
    "      # Status surface: curl localhost:9090/healthz",
    "      # If host port 9090 is taken, change only the left side.",
    '      - "127.0.0.1:9090:9090"',
  ];
  if (o.trigger === "webhook") ports.unshift('      - "8080:8080" # webhook trigger');
  lines.push("    ports:", ...ports);
  lines.push(
    "    restart: unless-stopped",
    "    read_only: true",
    "    tmpfs:",
    "      - /tmp",
    ...egressLines(o, withBuild),
    "",
    "volumes:",
    `  ${o.handle}-data:`,
    "",
    "networks:",
    // The agent sits on a network with no route off the host, so a subprocess
    // that ignores the proxy env vars has nowhere to go. The proxy is the only
    // service on both, which is what makes permissions.net true below the app.
    `  ${o.handle}-internal:`,
    "    internal: true",
    `  ${o.handle}-egress:`,
  );
  return lines.join("\n") + "\n";
}

/**
 * The egress proxy service, and the network split that makes it the only way
 * out. Without this a `permissions.run` grant reaches the whole internet: the
 * app-level engine never sees a subprocess's sockets, and the Deno sandbox
 * hands such an agent a broad --allow-net by design.
 */
function egressLines(o: InitOptions, withBuild: boolean): string[] {
  return [
    "    networks:",
    `      - ${o.handle}-internal`,
    "    environment:",
    "      # Everything outbound goes through the proxy: Deno's fetch honours",
    "      # these, and so do gh, curl and git over HTTPS.",
    `      HTTP_PROXY: http://${o.handle}-egress:3128`,
    `      HTTPS_PROXY: http://${o.handle}-egress:3128`,
    `      NO_PROXY: localhost,127.0.0.1,${o.handle}-egress`,
    "",
    `  ${o.handle}-egress:`,
    withBuild ? `    image: ${o.handle.toLowerCase()}` : `    image: ${IMAGE}`,
    '    command: ["egress", "/agent/agent.yaml"]',
    "    volumes:",
    "      - ./agent.yaml:/agent/agent.yaml:ro",
    "    env_file: .env",
    "    networks:",
    `      - ${o.handle}-internal # the agent reaches it here`,
    `      - ${o.handle}-egress   # and it reaches the internet here`,
    "    restart: unless-stopped",
    "    read_only: true",
  ];
}

function readme(o: InitOptions): string {
  const head = [
    `# ${o.handle}`,
    "",
    "Scaffolded by \`af init\`. Fill in the TODOs in \`agent.yaml\`, then:",
    "",
  ];
  const verify = [
    "",
    "## Verify",
    "",
    "- Service agents: \`curl -s localhost:9090/healthz\` — note the name the agent chose for itself.",
    "- The agent's memory, run history, and audit log live in the \`/data\` volume. Persist it: a lost volume is a fresh self.",
  ];
  const steps: string[] = [];
  switch (o.deploy) {
    case "local":
      steps.push(
        "```sh",
        "cp .env.example .env   # fill in your keys, then:",
        "af validate",
        "af run",
        "```",
        "",
        "(Install the CLI first: `deno install -g --allow-read --allow-write --allow-env --allow-net --allow-run=bash,docker,deno -n af jsr:@looped/af`.)",
      );
      break;
    case "docker":
      steps.push(
        "```sh",
        "cp .env.example .env",
        "docker run -d \\",
        "  -v ./agent.yaml:/agent/agent.yaml:ro \\",
        "  --env-file .env \\",
        `  -v ${o.handle}-data:/data \\`,
        ...(o.provider === "codex" ? ["  -v ~/.codex:/home/looped/.codex \\"] : []),
        ...(o.trigger === "webhook" ? ["  -p 8080:8080 \\"] : []),
        `  ${IMAGE}`,
        "```",
      );
      break;
    case "compose":
      steps.push("```sh", "cp .env.example .env", "docker compose up -d", "```");
      break;
    case "compose-inline":
      steps.push(
        "The agent's config lives **inside compose.yaml** — a top-level `configs:` element mounted into the container at `/agent/agent.yaml`. One file, no agent.yaml. Requires Docker Compose v2.23.1+ (inline `content:`).",
        "",
        "```sh",
        "cp .env.example .env",
        "docker compose up -d",
        "```",
        "",
        "Fill in the TODOs in `compose.yaml`. If you add env references to the embedded config, write them as `$${VAR}` so compose doesn't substitute the value at deploy time. Skills need real files — switch to the `compose` shape if you add skills later.",
      );
      break;
    case "paas-git":
      steps.push(
        "1. Push this directory to a git repository.",
        "2. In your platform (Coolify: *+ New* → *Docker Compose*), connect the repo.",
        "3. Set the env vars from `.env.example` in the platform UI — never commit `.env`.",
        "4. Deploy. The platform builds the image (config baked in) and manages the `/data` volume.",
      );
      break;
    case "paas-env":
      steps.push(
        "Deploy the stock image with **no files at all**:",
        "",
        `1. Image: \`${IMAGE}\``,
        "2. Env vars: everything in `.env.example`, **plus** `AF_AGENT_CONFIG` set to the full contents of `agent.yaml`:",
        "",
        "```sh",
        "cat agent.yaml # paste this as the value of AF_AGENT_CONFIG",
        "```",
        "",
        "3. Add a persistent volume at `/data`" +
          (o.trigger === "webhook" ? " and expose port 8080." : "."),
        "",
        "Note: the env-var route doesn't support skills (they're files). Switch to the baked-image shape if you add skills later.",
      );
      break;
  }
  return [...head, ...steps, ...verify].join("\n") + "\n";
}

/** Generate the project files for the chosen options: filename → content. */
export function generateProject(o: InitOptions): Record<string, string> {
  if (o.deploy === "compose-inline") {
    return {
      "compose.yaml": composeInlineYaml(o),
      ".env.example": envExample(o),
      "README.md": readme(o),
      ".gitignore": ".env\n",
    };
  }
  const files: Record<string, string> = {
    "agent.yaml": agentYaml(o),
    ".env.example": envExample(o),
    "README.md": readme(o),
  };
  const needsBuild = o.clis.length > 0 || o.deploy === "paas-git";
  if (needsBuild) files["Dockerfile"] = dockerfile(o);
  if (o.deploy === "compose" || o.deploy === "paas-git") {
    files["compose.yaml"] = composeYaml(o, needsBuild);
  }
  if (o.deploy === "paas-git" || o.deploy === "compose") {
    files[".gitignore"] = ".env\n";
  }
  return files;
}
