// af init — scaffold an agent project: the agent file, its secrets template,
// and the chosen deployment shape. Pure generation here; prompting/writing in
// main.ts. Principle (#19): no scaffold may require hand-managing files on a
// server — files live in git or on your laptop, or nowhere (env-var deploy).

export const TRIGGERS = ["discord", "webhook", "cron", "none"] as const;
export const PROVIDERS = ["openai-compatible", "anthropic", "local"] as const;
export const DEPLOYS = ["local", "docker", "compose", "paas-git", "paas-env"] as const;

export interface InitOptions {
  nickname: string;
  trigger: (typeof TRIGGERS)[number];
  provider: (typeof PROVIDERS)[number];
  /** Model id; sensible default per provider. */
  model?: string;
  /** Executables the agent needs (adds a Dockerfile layer + run permissions). */
  clis: string[];
  deploy: (typeof DEPLOYS)[number];
}

const MODELINE =
  "# yaml-language-server: $schema=https://raw.githubusercontent.com/loopedautomation/agent-framework/main/schema/agent.json";
const IMAGE = "ghcr.io/loopedautomation/agent:latest";

const DEFAULT_MODELS: Record<InitOptions["provider"], string> = {
  "openai-compatible": "gpt-5.4-mini",
  anthropic: "claude-sonnet-5",
  local: "llama3.1",
};

function keyEnv(provider: InitOptions["provider"]): string | undefined {
  if (provider === "openai-compatible") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  return undefined; // local endpoints need no key
}

function agentYaml(o: InitOptions): string {
  const lines: string[] = [
    MODELINE,
    `nickname: ${o.nickname} # your handle for it — the agent names itself on first boot`,
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
  if (o.trigger === "discord" || o.trigger === "webhook") {
    lines.push("", "memory:", "  scope: thread");
  }
  return lines.join("\n") + "\n";
}

function envExample(o: InitOptions): string {
  const vars: string[] = [];
  const key = keyEnv(o.provider);
  if (key) vars.push(`${key}=`);
  if (o.trigger === "discord") vars.push("DISCORD_BOT_TOKEN=");
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

function composeYaml(o: InitOptions, withBuild: boolean): string {
  const lines = ["services:", `  ${o.nickname}:`];
  lines.push(withBuild ? "    build: ." : `    image: ${IMAGE}`);
  if (!withBuild) lines.push("    volumes:", "      - ./agent.yaml:/agent/agent.yaml:ro");
  lines.push("    env_file: .env");
  if (withBuild) lines.push("    volumes:");
  lines.push(`      - ${o.nickname}-data:/data # the agent's memory and name live here`);
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
    "",
    "volumes:",
    `  ${o.nickname}-data:`,
  );
  return lines.join("\n") + "\n";
}

function readme(o: InitOptions): string {
  const head = [
    `# ${o.nickname}`,
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
        "(`af` = `deno task af` from a framework checkout until the CLI ships standalone.)",
      );
      break;
    case "docker":
      steps.push(
        "```sh",
        "cp .env.example .env",
        "docker run -d \\",
        "  -v ./agent.yaml:/agent/agent.yaml:ro \\",
        "  --env-file .env \\",
        `  -v ${o.nickname}-data:/data \\`,
        ...(o.trigger === "webhook" ? ["  -p 8080:8080 \\"] : []),
        `  ${IMAGE}`,
        "```",
      );
      break;
    case "compose":
      steps.push("```sh", "cp .env.example .env", "docker compose up -d", "```");
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
        "2. Env vars: everything in `.env.example`, **plus** `LOOPED_AGENT_CONFIG` set to the full contents of `agent.yaml`:",
        "",
        "```sh",
        "cat agent.yaml # paste this as the value of LOOPED_AGENT_CONFIG",
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
