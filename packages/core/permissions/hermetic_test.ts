import { assert, assertEquals } from "@std/assert";
import type { AgentConfig } from "../config/schema.ts";
import {
  derivedHosts,
  hermeticPlan,
  IMAGE_ENV,
  RUNTIME_READ_PATHS,
  RUNTIME_WRITE_PATHS,
} from "./hermetic.ts";

/** A minimal valid agent; each test overlays the part it cares about. */
function agent(overlay: Partial<AgentConfig> = {}): AgentConfig {
  return {
    handle: "scout",
    description: "watches things",
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    purpose: "watch things",
    limits: { max_steps: 20, concurrent_runs: 4, queue_depth: 10 },
    ...overlay,
  } as AgentConfig;
}

/** The container's env: status server on every interface, port 9090. */
const env = IMAGE_ENV;

Deno.test("hermetic/an agent that spawns nothing runs under its own net allowlist", () => {
  const plan = hermeticPlan(
    agent({ permissions: { net: ["api.github.com"] } }),
    env,
  );
  assert(plan.eligible);
  assertEquals(plan.blockers, []);
  assertEquals(plan.flags, [
    "--allow-env",
    `--allow-read=${RUNTIME_READ_PATHS.join(",")}`,
    `--allow-write=${RUNTIME_WRITE_PATHS.join(",")}`,
    // The model's endpoint and the status port are derived: an allowlist that
    // held only api.github.com would strand the agent before its first token.
    "--allow-net=0.0.0.0:9090,api.anthropic.com,api.github.com",
  ]);
  // No --allow-run: nothing may leave the sandbox and call out unwatched.
  assert(!plan.flags.some((f) => f.startsWith("--allow-run")));
});

Deno.test("hermetic/a run grant disqualifies the agent", () => {
  const plan = hermeticPlan(agent({ permissions: { net: ["api.github.com"], run: ["gh"] } }), env);
  assert(!plan.eligible);
  assert(plan.blockers[0].includes("gh"));
  // gh reaches any host it likes; Deno can't hold a subprocess, so the flags
  // stay the image's and the container is the boundary.
  assert(plan.flags.includes("--allow-net"));
});

Deno.test("hermetic/a stdio MCP server disqualifies the agent", () => {
  const plan = hermeticPlan(
    agent({
      permissions: { net: ["api.github.com"] },
      tools: { search: "auto", mcp: [{ name: "gh", command: ["docker", "run", "-i", "mcp"] }] },
    }),
    env,
  );
  assert(!plan.eligible);
  assert(plan.blockers[0].includes('"gh" is stdio'));
});

Deno.test("hermetic/an HTTP MCP server keeps the agent hermetic and joins the allowlist", () => {
  const plan = hermeticPlan(
    agent({
      permissions: { net: ["api.github.com"] },
      tools: { search: "auto", mcp: [{ name: "linear", url: "https://mcp.linear.app/sse" }] },
    }),
    env,
  );
  assert(plan.eligible);
  assert(plan.hosts.includes("mcp.linear.app"));
});

Deno.test("hermetic/a wildcard host compiles and the agent stays hermetic", () => {
  const plan = hermeticPlan(agent({ permissions: { net: ["*.example.com"] } }), env);
  assert(plan.eligible);
  assertEquals(plan.blockers, []);
  assert(plan.hosts.includes("*.example.com"));
  assert(plan.flags.includes("--allow-net=0.0.0.0:9090,api.anthropic.com,*.example.com"));
});

Deno.test("hermetic/net: ['*'] stays hermetic — open web, everything else still shut", () => {
  const plan = hermeticPlan(agent({ permissions: { net: ["*"], read: ["/workspace"] } }), env);
  assert(plan.eligible);
  assert(plan.flags.includes("--allow-net"));
  assert(plan.flags.includes(`--allow-read=${RUNTIME_READ_PATHS.join(",")},/workspace`));
  assert(!plan.flags.some((f) => f.startsWith("--allow-run")));
});

Deno.test("hermetic/the model endpoint is derived from the provider or the base_url", () => {
  assert(derivedHosts(agent(), env).includes("api.anthropic.com"));
  assert(
    derivedHosts(agent({ model: { provider: "openai-compatible", id: "gpt-5.4-mini" } }), env)
      .includes("api.openai.com"),
  );
  // codex needs both the OAuth endpoint and the backend.
  const codex = derivedHosts(agent({ model: { provider: "codex", id: "gpt-5.4-codex" } }), env);
  assert(codex.includes("auth.openai.com"));
  assert(codex.includes("chatgpt.com"));
  // A base_url replaces the default, port included — Ollama on the host.
  assert(
    derivedHosts(
      agent({
        model: { provider: "openai-compatible", id: "llama3", base_url: "http://ollama:11434/v1" },
      }),
      env,
    ).includes("ollama:11434"),
  );
});

Deno.test("hermetic/triggers contribute the hosts they reach and the ports they listen on", () => {
  const hosts = derivedHosts(
    agent({
      triggers: [
        {
          type: "discord",
          token_env: "DISCORD_BOT_TOKEN",
          allow_silence: false,
          show_typing: false,
        },
        { type: "telegram", token_env: "TELEGRAM_BOT_TOKEN", allow_silence: false },
        { type: "webhook", path: "/", port: 8080, token_env: "WEBHOOK_TOKEN" },
        { type: "tty", path: "/tty", port: 8300, token_env: "TTY_TOKEN" },
        { type: "cron", schedule: "0 9 * * 1", prompt: "morning" },
      ] as AgentConfig["triggers"],
    }),
    env,
  );
  assert(hosts.includes("discord.com"));
  assert(hosts.includes("gateway.discord.gg")); // the gateway is a second host
  assert(hosts.includes("api.telegram.org"));
  assert(hosts.includes("0.0.0.0:8080")); // listen rights, not egress
  assert(hosts.includes("0.0.0.0:8300")); // tty listens like webhook does
  assert(hosts.includes("0.0.0.0:9090")); // the status server
});

Deno.test("hermetic/voice engines contribute their hosts", () => {
  const hosts = derivedHosts(
    agent({
      voice: { stt: { provider: "openai" }, tts: { provider: "elevenlabs" } },
      triggers: [
        {
          type: "discord",
          token_env: "DISCORD_BOT_TOKEN",
          allow_silence: false,
          show_typing: false,
        },
      ] as AgentConfig["triggers"],
    }),
    env,
  );
  assert(hosts.includes("api.openai.com"));
  assert(hosts.includes("api.elevenlabs.io"));
  // The audio itself downloads from the discord trigger's own hosts (Plan 14).
  assert(hosts.includes("cdn.discordapp.com"));

  // Without a discord trigger there is no CDN; without tts, only stt's host.
  const telegramOnly = derivedHosts(
    agent({
      voice: { stt: { provider: "elevenlabs" } },
      triggers: [
        { type: "telegram", token_env: "TELEGRAM_BOT_TOKEN", allow_silence: false },
      ] as AgentConfig["triggers"],
    }),
    env,
  );
  assert(telegramOnly.includes("api.elevenlabs.io"));
  assert(!telegramOnly.includes("cdn.discordapp.com"));
  assert(!telegramOnly.includes("api.openai.com"));
});

Deno.test("hermetic/live voice reaches the realtime API and the voice servers", () => {
  const live = {
    voice: {
      live: { provider: "openai", model: "gpt-realtime-2.1", voice: "marin", idle_seconds: 60 },
    },
    triggers: [
      {
        type: "discord",
        token_env: "DISCORD_BOT_TOKEN",
        allow_silence: false,
        show_typing: false,
        voice_channels: ["lounge"],
      },
    ],
  } as unknown as Partial<AgentConfig>;
  const hosts = derivedHosts(agent(live), env);
  assert(hosts.includes("api.openai.com"));
  // Voice servers live at per-session hostnames; the wildcard is what makes
  // them expressible at all.
  assert(hosts.includes("*.discord.media"));

  // …but the media itself is UDP, which Deno cannot hold — so the agent runs
  // under the image's flags, with the container as its egress boundary.
  const plan = hermeticPlan(agent(live), env);
  assert(!plan.eligible);
  assert(plan.blockers[0].includes("UDP"));
});

Deno.test("hermetic/imap mail hosts come from the config, ports and all", () => {
  const hosts = derivedHosts(
    agent({
      triggers: [{
        type: "email",
        transport: "imap",
        host: "imap.fastmail.com",
        port: 993,
        username: "agent@looped.sh",
        password_env: "IMAP_PASSWORD",
        smtp_host: "smtp.fastmail.com",
        smtp_port: 465,
        folder: "INBOX",
        poll_seconds: 60,
        from_addresses: ["*@looped.sh"],
        allow_silence: false,
      }] as AgentConfig["triggers"],
    }),
    env,
  );
  assert(hosts.includes("imap.fastmail.com:993"));
  assert(hosts.includes("smtp.fastmail.com:465"));
});

Deno.test("hermetic/the image's flags carry what the narrowed flags replace", async () => {
  const dockerfile = await Deno.readTextFile(
    new URL("../../../images/agent/Dockerfile", import.meta.url),
  );
  // The ENTRYPOINT is the widest sandbox an agent runs under, and hermetic mode
  // swaps it out wholesale — so the paths it grants have to be the ones the
  // narrowed flags carry forward, or a hermetic agent loses its own data volume.
  assert(dockerfile.includes(`--allow-read=${RUNTIME_READ_PATHS.join(",")}`));
  assert(dockerfile.includes(`--allow-write=${RUNTIME_WRITE_PATHS.join(",")}`));
  // The entrypoint must be able to spawn the narrowed child.
  assert(dockerfile.includes("--allow-run=bash,deno"));
});
