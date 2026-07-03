// af — the Looped AF CLI, a thin client over @looped/af.
//   af run <agent.yaml>       run an agent: service mode if it has triggers, REPL otherwise
//   af validate <agent.yaml>  validate a config and report env references
//   af flags <agent.yaml>     print the Deno permission flags the config compiles to
//   af schema                 print the agent.yaml JSON Schema

import {
  type AgentConfig,
  agentConfigJsonSchema,
  AgentService,
  collectEnvRefs,
  ConfigError,
  permissionsToDenoFlags,
  ProviderError,
  resolveAgentConfig,
  type RunResult,
  startStatusServer,
  VERSION,
} from "@looped/af";
import { fetchApplicationId, inviteUrl, triggersFromConfig } from "@looped/triggers";
import { printBirthBanner } from "./banner.ts";

// Paths default to ./agent.yaml; LOOPED_AGENT_CONFIG (the YAML itself in an
// env var) replaces the file entirely for file-less platform deploys.
const DEFAULT_CONFIG = "agent.yaml";

const USAGE = `af ${VERSION}

Usage:
  af run [agent.yaml]       Run an agent (service mode with triggers, REPL without)
  af validate [agent.yaml]  Validate an agent definition
  af flags [agent.yaml]     Print compiled Deno permission flags
  af schema                 Print the agent.yaml JSON Schema
  af discord-invite [agent.yaml]
                            Print the bot's OAuth invite URL (no bitfield math)
`;

async function discordInvite(path: string) {
  const config = await resolveAgentConfig(path);
  const trigger = config.triggers?.find((t) => t.type === "discord");
  if (!trigger || trigger.type !== "discord") {
    fail(`${path} has no discord trigger`);
  }
  const token = Deno.env.get(trigger.token_env);
  if (!token) {
    fail(
      `${trigger.token_env} is not set — the invite URL needs the bot token to look up the app id`,
    );
  }
  const appId = await fetchApplicationId(token);
  console.log(inviteUrl(appId));
  console.log(
    "%copen this URL to invite the bot (grants: View Channels, Send Messages, Read Message History)",
    "color: gray",
  );
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(1);
}

function statusLine(result: RunResult): string {
  const cost = result.costUsd !== undefined ? ` · $${result.costUsd.toFixed(6)}` : "";
  return `[${result.status} · ${result.steps} step${result.steps === 1 ? "" : "s"} · ` +
    `${result.usage.inputTokens}in/${result.usage.outputTokens}out tokens${cost}]`;
}

async function validate(path: string) {
  const config = await resolveAgentConfig(path);
  console.log(`✓ ${path} is a valid agent definition`);
  console.log(`  nickname: ${config.nickname}`);
  console.log(`  model:    ${config.model.provider} / ${config.model.id}`);
  console.log(`  triggers: ${config.triggers?.map((t) => t.type).join(", ") ?? "none (CLI only)"}`);
  const flags = permissionsToDenoFlags(config.permissions);
  if (flags.length) console.log(`  sandbox:  ${flags.join(" ")}`);
  const refs = collectEnvRefs(config);
  if (refs.length) {
    const missing = refs.filter((name) => Deno.env.get(name) === undefined);
    console.log(`  env refs: ${refs.join(", ")}`);
    if (missing.length) console.log(`  ⚠ not set in this environment: ${missing.join(", ")}`);
  }
}

async function repl(config: AgentConfig, service: AgentService, name: string) {
  console.log(
    `${name} (${config.nickname}) is listening (model: ${config.model.id}; ctrl-d to exit)`,
  );
  const conversationKey = config.memory?.scope === "thread" ? "cli" : undefined;
  while (true) {
    const input = prompt("you>");
    if (input === null) break; // EOF
    if (!input.trim()) continue;
    const result = await service.handle({
      id: crypto.randomUUID(),
      trigger: "cli",
      input,
      conversationKey,
    });
    console.log(`\n${name}> ${result.reply}\n`);
    console.log(`%c${statusLine(result)}`, "color: gray");
  }
}

async function serve(config: AgentConfig, service: AgentService, name: string) {
  const triggers = triggersFromConfig(config);
  await service.start(triggers);
  const status = startStatusServer(service);
  console.log(
    `${name} (${config.nickname}) is running as a service ` +
      `(triggers: ${config.triggers!.map((t) => t.type).join(", ")}; ctrl-c to stop)`,
  );
  await new Promise<void>((resolve) => {
    Deno.addSignalListener("SIGINT", () => resolve());
    Deno.addSignalListener("SIGTERM", () => resolve());
  });
  console.log("\nshutting down...");
  await status.shutdown();
  await service.stop();
}

async function run(path: string) {
  const config = await resolveAgentConfig(path);
  const baseDir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  const service = new AgentService({ config, baseDir });
  const identity = await service.init();
  if (identity.isNew) printBirthBanner(config.nickname, identity.name);
  if (config.triggers?.length) await serve(config, service, identity.name);
  else await repl(config, service, identity.name);
}

async function main() {
  const [command, arg] = Deno.args;
  try {
    switch (command) {
      case "run":
        await run(arg ?? DEFAULT_CONFIG);
        break;
      case "validate":
        await validate(arg ?? DEFAULT_CONFIG);
        break;
      case "flags": {
        const config = await resolveAgentConfig(arg ?? DEFAULT_CONFIG);
        console.log(permissionsToDenoFlags(config.permissions).join(" "));
        break;
      }
      case "schema":
        console.log(JSON.stringify(agentConfigJsonSchema(), null, 2));
        break;
      case "discord-invite":
        if (!arg) fail("usage: af discord-invite [agent.yaml]");
        await discordInvite(arg);
        break;
      default:
        console.log(USAGE);
        Deno.exit(command ? 1 : 0);
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ProviderError) fail(err.message);
    throw err;
  }
}

if (import.meta.main) await main();
