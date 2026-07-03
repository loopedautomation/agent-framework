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
  loadAgentConfig,
  permissionsToDenoFlags,
  ProviderError,
  type RunResult,
  VERSION,
} from "@looped/af";
import { triggersFromConfig } from "@looped/triggers";

const USAGE = `af ${VERSION}

Usage:
  af run <agent.yaml>       Run an agent (service mode with triggers, REPL without)
  af validate <agent.yaml>  Validate an agent definition
  af flags <agent.yaml>     Print compiled Deno permission flags
  af schema                 Print the agent.yaml JSON Schema
`;

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
  const config = await loadAgentConfig(path);
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

async function repl(config: AgentConfig, service: AgentService) {
  console.log(`${config.nickname} is listening (model: ${config.model.id}; ctrl-d to exit)`);
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
    console.log(`\n${config.nickname}> ${result.reply}\n`);
    console.log(`%c${statusLine(result)}`, "color: gray");
  }
}

async function serve(config: AgentConfig, service: AgentService) {
  const triggers = triggersFromConfig(config);
  await service.start(triggers);
  console.log(
    `${config.nickname} is running as a service ` +
      `(triggers: ${config.triggers!.map((t) => t.type).join(", ")}; ctrl-c to stop)`,
  );
  await new Promise<void>((resolve) => {
    Deno.addSignalListener("SIGINT", () => resolve());
    Deno.addSignalListener("SIGTERM", () => resolve());
  });
  console.log("\nshutting down...");
  await service.stop();
}

async function run(path: string) {
  const config = await loadAgentConfig(path);
  const service = new AgentService({ config });
  if (config.triggers?.length) await serve(config, service);
  else await repl(config, service);
}

async function main() {
  const [command, arg] = Deno.args;
  try {
    switch (command) {
      case "run":
        if (!arg) fail("usage: af run <agent.yaml>");
        await run(arg);
        break;
      case "validate":
        if (!arg) fail("usage: af validate <agent.yaml>");
        await validate(arg);
        break;
      case "flags": {
        if (!arg) fail("usage: af flags <agent.yaml>");
        const config = await loadAgentConfig(arg);
        console.log(permissionsToDenoFlags(config.permissions).join(" "));
        break;
      }
      case "schema":
        console.log(JSON.stringify(agentConfigJsonSchema(), null, 2));
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
