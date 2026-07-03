// looped — thin CLI over @looped/af.
//   looped run <agent.yaml>       run an agent interactively (M1: CLI stands in for triggers)
//   looped validate <agent.yaml>  validate a config and report env references
//   looped schema                 print the agent.yaml JSON Schema

import {
  agentConfigJsonSchema,
  collectEnvRefs,
  ConfigError,
  createProvider,
  currentTimeTool,
  loadAgentConfig,
  type Message,
  ProviderError,
  runAgent,
  VERSION,
} from "@looped/af";

const USAGE = `looped ${VERSION}

Usage:
  looped run <agent.yaml>       Run an agent interactively
  looped validate <agent.yaml>  Validate an agent definition
  looped schema                 Print the agent.yaml JSON Schema
`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(1);
}

async function validate(path: string) {
  const config = await loadAgentConfig(path);
  console.log(`✓ ${path} is a valid agent definition`);
  console.log(`  nickname: ${config.nickname}`);
  console.log(`  model:    ${config.model.provider} / ${config.model.id}`);
  console.log(`  triggers: ${config.triggers?.map((t) => t.type).join(", ") ?? "none (CLI only)"}`);
  const refs = collectEnvRefs(config);
  if (refs.length) {
    const missing = refs.filter((name) => Deno.env.get(name) === undefined);
    console.log(`  env refs: ${refs.join(", ")}`);
    if (missing.length) console.log(`  ⚠ not set in this environment: ${missing.join(", ")}`);
  }
}

async function run(path: string) {
  const config = await loadAgentConfig(path);
  const provider = createProvider(config.model);
  const tools = [currentTimeTool];
  let history: Message[] = [];

  console.log(`${config.nickname} is listening (model: ${config.model.id}; ctrl-d to exit)`);
  while (true) {
    const input = prompt("you>");
    if (input === null) break; // EOF
    if (!input.trim()) continue;

    const result = await runAgent({ config, provider, tools, input, history });
    history = result.messages;

    console.log(`\n${config.nickname}> ${result.reply}\n`);
    const cost = result.costUsd !== undefined ? ` · $${result.costUsd.toFixed(6)}` : "";
    console.log(
      `%c[${result.status} · ${result.steps} step${result.steps === 1 ? "" : "s"} · ` +
        `${result.usage.inputTokens}in/${result.usage.outputTokens}out tokens${cost}]`,
      "color: gray",
    );
  }
}

async function main() {
  const [command, arg] = Deno.args;
  try {
    switch (command) {
      case "run":
        if (!arg) fail("usage: looped run <agent.yaml>");
        await run(arg);
        break;
      case "validate":
        if (!arg) fail("usage: looped validate <agent.yaml>");
        await validate(arg);
        break;
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
