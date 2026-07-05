/**
 * af - the Looped AF CLI, a docker frontend over @looped/core.
 *
 * ```
 * af run <agent.yaml>       run one agent in Docker, interactive
 * af up <agent.yaml...>     start agents in Docker (foreground; -d to detach)
 * af down / af ps           stop / list af containers
 * af validate <agent.yaml>  validate a config and report env references
 * af update                 reinstall af at the latest published version
 * ```
 *
 * Nothing executes on the host: run/up start the published container image.
 * Inside the container (AF_CONTAINER=1, set by the image) `run` executes the
 * agent in-process - that in-process branch IS the container entrypoint.
 *
 * @module
 */

import {
  agentConfigJsonSchema,
  ConfigError,
  permissionsToDenoFlags,
  ProviderError,
  resolveAgentConfig,
  VERSION,
} from "@looped/core";
import { discordInvite } from "./discord.ts";
import {
  DEFAULT_CONFIG,
  dockerRun,
  down,
  fail,
  parseCommandArgs,
  ps,
  up,
} from "./docker_commands.ts";
import { init } from "./init_command.ts";
import { runLocal, validate } from "./local.ts";
import { accent, dim, table } from "./style.ts";
import { update } from "./update_command.ts";

// Set by the image: `run` executes in-process (the container entrypoint)
// instead of spawning docker inside docker.
const IN_CONTAINER = Deno.env.get("AF_CONTAINER") !== undefined;

function usage(): string {
  const commands: [string, string][] = [
    ["af init [name]", "Scaffold a new agent project (agent, secrets, deployment)"],
    ["af run [agent.yaml]", "Run one agent in Docker, interactive (REPL without triggers)"],
    ["af up [agent.yaml...]", "Start agents in Docker — foreground; -d to detach"],
    ["af ps", "List af containers"],
    ["af down [target...]", "Stop and remove af containers (files or handles; none = all)"],
    ["af validate [agent.yaml]", "Validate an agent definition"],
    ["af flags [agent.yaml]", "Print compiled Deno permission flags"],
    ["af schema", "Print the agent.yaml JSON Schema"],
    ["af discord-invite [agent.yaml]", "Print the bot's OAuth invite URL (no bitfield math)"],
    ["af update", "Reinstall af at the latest published version"],
  ];
  const flags: [string, string][] = [
    ["-d, --detach", "up: leave agents running in the background (restart unless-stopped)"],
    ["--dry-run", "run/up: print the docker command(s) and start nothing"],
    ["--image <ref>", "run/up: container image override"],
    ["--env-file <path>", "run/up: env file (default: .env next to the agent file)"],
  ];
  return [
    `${accent("af")} ${VERSION} ${dim("· one job · one file · it’s hired · looped.sh")}`,
    "",
    ...table(commands.map(([c, d]) => [`  ${accent(c)}`, dim(d)])),
    "",
    ...table(flags.map(([f, d]) => [`  ${f}`, dim(d)])),
  ].join("\n");
}

async function main() {
  const [command, arg] = Deno.args;
  const rest = () => parseCommandArgs(Deno.args.slice(1));
  try {
    switch (command) {
      case "init":
        init(arg?.startsWith("--") ? undefined : arg);
        break;
      case "run": {
        if (IN_CONTAINER) {
          await runLocal(arg ?? DEFAULT_CONFIG);
          break;
        }
        const { flags, positional } = rest();
        await dockerRun(positional[0] ?? DEFAULT_CONFIG, flags);
        break;
      }
      case "up": {
        const { flags, positional } = rest();
        await up(positional, flags);
        break;
      }
      case "ps":
        await ps();
        break;
      case "down": {
        const { positional } = rest();
        await down(positional);
        break;
      }
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
      case "update":
        await update();
        break;
      default:
        console.log(usage());
        Deno.exit(command && command !== "--help" && command !== "-h" ? 1 : 0);
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ProviderError) fail(err.message);
    throw err;
  }
}

if (import.meta.main) await main();
