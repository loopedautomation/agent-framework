// af — the Looped AF CLI, a docker frontend over @looped/core.
//   af run <agent.yaml>       run one agent in Docker, interactive
//   af up <agent.yaml...>     start agents in Docker (foreground; -d to detach)
//   af down / af ps           stop / list af containers
//   af validate <agent.yaml>  validate a config and report env references
//
// Nothing executes on the host: run/up start the published container image.
// Inside the container (AF_CONTAINER=1, set by the image) `run` executes the
// agent in-process — that in-process branch IS the container entrypoint.

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
} from "@looped/core";
import { fetchApplicationId, inviteUrl, triggersFromConfig } from "@looped/triggers";
import { printBirthBanner } from "./banner.ts";
import { DEPLOYS, generateProject, type InitOptions, PROVIDERS, TRIGGERS } from "./init.ts";
import {
  dockerPortArgs,
  dockerPsArgs,
  dockerRmArgs,
  dockerRunArgs,
  dockerRunningArgs,
  dockerStopArgs,
  parsePsLine,
  type PsEntry,
  type RunMode,
} from "./docker.ts";
import { accent, dim, err as red, gradientAt, ok, paint, Spinner, table, warn } from "./style.ts";

// Paths default to ./agent.yaml; AF_AGENT_CONFIG (the YAML itself in an
// env var) replaces the file entirely for file-less platform deploys.
const DEFAULT_CONFIG = "agent.yaml";

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

function fail(message: string): never {
  console.error(`${red("error:")} ${message}`);
  Deno.exit(1);
}

// ---------- docker plumbing ----------

interface CommandFlags {
  detach: boolean;
  dryRun: boolean;
  image?: string;
  envFile?: string;
}

/** Positionals + the run/up/down flag set, from everything after the command. */
function parseCommandArgs(tokens: string[]): { flags: CommandFlags; positional: string[] } {
  const flags: CommandFlags = { detach: false, dryRun: false };
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-d" || t === "--detach") flags.detach = true;
    else if (t === "--dry-run") flags.dryRun = true;
    else if (t === "--image") flags.image = tokens[++i] ?? fail("--image needs a value");
    else if (t === "--env-file") flags.envFile = tokens[++i] ?? fail("--env-file needs a value");
    else if (t.startsWith("-")) fail(`unknown flag ${t} (af --help for usage)`);
    else positional.push(t);
  }
  return { flags, positional };
}

async function dockerCapture(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const out = await new Deno.Command("docker", {
      args,
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      fail("docker not found — af runs agents in containers and needs Docker installed");
    }
    throw e;
  }
}

interface PreparedAgent {
  config: AgentConfig;
  args: string[];
  envFile?: string;
}

/** Parse + validate the agent file and compile its docker run argv. */
async function prepare(path: string, mode: RunMode, f: CommandFlags): Promise<PreparedAgent> {
  const config = await resolveAgentConfig(path);
  const configPath = await Deno.realPath(path).catch(() => undefined);
  if (!configPath) {
    fail(
      `${path} is not a file — docker mode mounts the agent file into the container ` +
        `(AF_AGENT_CONFIG works for platform deploys, not for af run/up)`,
    );
  }

  // Env file: explicit flag, else a .env sitting next to the agent file.
  const baseDir = configPath.slice(0, configPath.lastIndexOf("/"));
  let envFile = f.envFile;
  if (envFile === undefined) {
    const sibling = `${baseDir}/.env`;
    if (await Deno.stat(sibling).then((s) => s.isFile).catch(() => false)) envFile = sibling;
  } else {
    envFile = await Deno.realPath(envFile).catch(() => fail(`cannot read env file ${f.envFile}`));
  }

  // The container only sees the env file — warn on refs it won't find there.
  const refs = collectEnvRefs(config);
  if (refs.length) {
    const provided = new Set<string>();
    if (envFile) {
      for (const line of (await Deno.readTextFile(envFile)).split("\n")) {
        const name = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
        if (name) provided.add(name);
      }
    }
    const missing = refs.filter((name) => !provided.has(name));
    if (missing.length) {
      console.error(
        `${warn("⚠")} not in ${envFile ? envFile.slice(baseDir.length + 1) : "any env file"}: ` +
          `${missing.join(", ")} ${dim("(the container gets only the env file)")}`,
      );
    }
  }

  const tty = mode === "interactive" ? Deno.stdin.isTerminal() : undefined;
  return {
    config,
    args: dockerRunArgs(config, { mode, configPath, envFile, image: f.image, tty }),
    envFile,
  };
}

/** Fail loudly when a handle already has a container (running or stopped). */
async function ensureNotRunning(handle: string) {
  const existing = (await dockerCapture(dockerRunningArgs(handle))).stdout.trim();
  if (existing) {
    fail(`${handle} already has a container — run \`af down ${handle}\` first`);
  }
}

async function statusAddr(handle: string): Promise<string | undefined> {
  const res = await dockerCapture(dockerPortArgs(handle));
  return res.stdout.split("\n")[0].trim() || undefined;
}

/** Poll the mapped status port until the agent answers (or we give up). */
async function waitHealthy(addr: string | undefined, timeoutMs = 30_000): Promise<boolean> {
  if (!addr) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${addr}/healthz`);
      await res.body?.cancel();
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Prefix every line of a child stream — fleets stay scannable interleaved. */
async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  write: (line: string) => void,
) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) write(`${prefix} ${line}`);
  }
  if (buf) write(`${prefix} ${buf}`);
}

// ---------- commands ----------

/** af run — one agent, interactive, in the foreground (docker run -it --rm). */
async function dockerRun(path: string, f: CommandFlags) {
  const agent = await prepare(path, "interactive", f);
  if (f.dryRun) {
    console.log(["docker", ...agent.args].join(" "));
    return;
  }
  await ensureNotRunning(agent.config.handle);
  const kind = agent.config.triggers?.length
    ? `service (triggers: ${agent.config.triggers.map((t) => t.type).join(", ")})`
    : "REPL";
  console.log(dim(`⏵ ${agent.config.handle} in docker — ${kind}; ctrl-c to stop`));
  const child = new Deno.Command("docker", {
    args: agent.args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  if (!status.success) Deno.exit(status.code);
}

/** af up — start agents; foreground streams logs, -d detaches. */
async function up(paths: string[], f: CommandFlags) {
  const targets = paths.length ? paths : [DEFAULT_CONFIG];
  const mode: RunMode = f.detach ? "detached" : "attached";
  const agents: PreparedAgent[] = [];
  for (const p of targets) agents.push(await prepare(p, mode, f));

  if (f.dryRun) {
    for (const a of agents) console.log(["docker", ...a.args].join(" "));
    return;
  }
  for (const a of agents) await ensureNotRunning(a.config.handle);

  if (f.detach) {
    for (const a of agents) {
      const spin = new Spinner();
      spin.start(`starting ${a.config.handle}…`);
      const res = await dockerCapture(a.args);
      if (res.code !== 0) {
        spin.stop();
        fail(`docker run failed for ${a.config.handle}: ${res.stderr.trim()}`);
      }
      spin.update(`waiting for ${a.config.handle} to answer…`);
      const addr = await statusAddr(a.config.handle);
      const healthy = await waitHealthy(addr);
      spin.stop(
        healthy
          ? `${ok("✓")} ${accent(a.config.handle)}  running ${dim(`· status http://${addr}`)}`
          : `${warn("⚠")} ${accent(a.config.handle)}  started, not answering yet ` +
            dim(`(docker logs af-${a.config.handle})`),
      );
    }
    console.log(dim(`\n${accent("af ps")} to inspect · ${accent("af down")} to stop`));
    return;
  }

  // Foreground fleet: attached docker run per agent, prefixed logs, ctrl-c stops all.
  console.log(dim(`⏵ ${agents.map((a) => a.config.handle).join(", ")} — ctrl-c to stop\n`));
  const children = agents.map((a, i) => {
    const child = new Deno.Command("docker", {
      args: a.args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const prefix = paint(`[${a.config.handle}]`, gradientAt(i));
    return {
      handle: a.config.handle,
      child,
      pumps: [
        pumpLines(child.stdout, prefix, console.log),
        pumpLines(child.stderr, prefix, console.error),
      ],
    };
  });
  const stopAll = () => {
    for (const c of children) {
      try {
        c.child.kill("SIGINT");
      } catch {
        // already gone
      }
    }
  };
  Deno.addSignalListener("SIGINT", stopAll);
  Deno.addSignalListener("SIGTERM", stopAll);
  await Promise.all(children.map(async (c) => {
    await Promise.all(c.pumps);
    const status = await c.child.status;
    if (!status.success) console.error(`${red("✗")} ${c.handle} exited (${status.code})`);
  }));
}

/** af ps — the af containers, running or stopped. */
async function ps() {
  const res = await dockerCapture(dockerPsArgs());
  if (res.code !== 0) fail(res.stderr.trim() || "docker ps failed");
  const entries = res.stdout.split("\n").filter(Boolean)
    .map(parsePsLine).filter((e): e is PsEntry => e !== undefined);
  if (!entries.length) {
    console.log(dim(`no af containers — ${accent("af up agent.yaml")} to start one`));
    return;
  }
  const rows = [
    ["HANDLE", "STATE", "STATUS", "STATUS ADDR"].map(dim),
    ...entries.map((e) => [
      accent(e.handle),
      e.state === "running" ? ok(e.state) : red(e.state),
      e.status,
      e.statusAddr ? dim(e.statusAddr) : dim("—"),
    ]),
  ];
  for (const line of table(rows)) console.log(line);
}

/** af down — graceful stop + remove; targets are agent files or handles. */
async function down(targets: string[]) {
  let handles: string[];
  if (targets.length) {
    handles = [];
    for (const t of targets) {
      if (t.includes("/") || t.endsWith(".yaml") || t.endsWith(".yml")) {
        handles.push((await resolveAgentConfig(t)).handle);
      } else handles.push(t);
    }
  } else {
    const res = await dockerCapture(dockerPsArgs());
    if (res.code !== 0) fail(res.stderr.trim() || "docker ps failed");
    handles = res.stdout.split("\n").filter(Boolean)
      .map(parsePsLine).filter((e): e is PsEntry => e !== undefined)
      .map((e) => e.handle);
  }
  handles = [...new Set(handles)];
  if (!handles.length) {
    console.log(dim("nothing to stop"));
    return;
  }

  const spin = new Spinner();
  spin.start(`stopping ${handles.join(", ")}…`);
  await dockerCapture(dockerStopArgs(handles));
  // --rm containers vanish on stop; rm cleans up the detached ones. Verify per
  // handle instead of trusting exit codes.
  await dockerCapture(dockerRmArgs(handles));
  spin.stop();
  for (const handle of handles) {
    const left = (await dockerCapture(dockerRunningArgs(handle))).stdout.trim();
    if (left) console.error(`${red("✗")} ${handle} is still there (docker rm -f af-${handle}?)`);
    else {console.log(
        `${ok("✓")} ${accent(handle)} ${dim("stopped and removed · data volume kept")}`,
      );}
  }
}

// ---------- in-container / local execution (the container entrypoint) ----------

function statusLine(result: RunResult): string {
  return `[${result.status} · ${result.steps} step${result.steps === 1 ? "" : "s"} · ` +
    `${result.usage.inputTokens}in/${result.usage.outputTokens}out tokens]`;
}

async function validate(path: string) {
  const config = await resolveAgentConfig(path);
  console.log(`${ok("✓")} ${path} is a valid agent definition`);
  console.log(`  handle:   ${accent(config.handle)}`);
  console.log(`  model:    ${config.model.provider} / ${config.model.id}`);
  console.log(`  triggers: ${config.triggers?.map((t) => t.type).join(", ") ?? "none (CLI only)"}`);
  const flags = permissionsToDenoFlags(config.permissions);
  if (flags.length) console.log(`  sandbox:  ${flags.join(" ")}`);
  const refs = collectEnvRefs(config);
  if (refs.length) {
    const missing = refs.filter((name) => Deno.env.get(name) === undefined);
    console.log(`  env refs: ${refs.join(", ")}`);
    if (missing.length) {
      console.log(`  ${warn("⚠")} not set in this environment: ${missing.join(", ")}`);
    }
  }
}

async function repl(config: AgentConfig, service: AgentService, name: string) {
  console.log(
    `${name} (${config.handle}) is listening (model: ${config.model.id}; ctrl-d to exit)`,
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
    console.log(dim(statusLine(result)));
  }
}

async function serve(config: AgentConfig, service: AgentService, name: string) {
  const triggers = triggersFromConfig(config);
  await service.start(triggers);
  const status = startStatusServer(service);
  console.log(
    `${name} (${config.handle}) is running as a service ` +
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

/** In-process execution: only inside the container (or AF_CONTAINER=1 for framework dev). */
async function runLocal(path: string) {
  const config = await resolveAgentConfig(path);
  const baseDir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  const service = new AgentService({ config, baseDir });
  const identity = await service.init();
  if (identity.isNew) printBirthBanner(config.handle, identity.name);
  if (config.triggers?.length) await serve(config, service, identity.name);
  else await repl(config, service, identity.name);
}

// ---------- init ----------

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
    dim(
      "open this URL to invite the bot (grants: View Channels, Send Messages, Read Message History)",
    ),
  );
}

function flag(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

function choose<T extends string>(label: string, options: readonly T[], flagValue?: string): T {
  if (flagValue) {
    if ((options as readonly string[]).includes(flagValue)) return flagValue as T;
    fail(`--${label} must be one of: ${options.join(", ")}`);
  }
  console.log(`${label}:`);
  options.forEach((option, i) => console.log(`  ${i + 1}. ${option}`));
  const picked = prompt(`choose [1-${options.length}]:`) ?? "";
  const index = Number(picked) - 1;
  if (!options[index]) fail(`pick a number between 1 and ${options.length}`);
  return options[index];
}

function init(nameArg?: string) {
  const handle = nameArg ?? flag("handle") ??
    prompt("handle (lowercase, hyphens — what you'll call the agent):") ?? "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) {
    fail("handle must be lowercase alphanumeric with hyphens");
  }
  const trigger = choose("trigger", TRIGGERS, flag("trigger"));
  const provider = choose("provider", PROVIDERS, flag("provider"));
  const deploy = choose("deploy", DEPLOYS, flag("deploy"));
  const clis =
    (flag("clis") ?? prompt("CLIs the agent needs (comma-separated, empty for none):") ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);

  const options: InitOptions = { handle, trigger, provider, model: flag("model"), clis, deploy };
  const files = generateProject(options);

  const target = `${flag("dir") ?? "."}/${handle}`;
  try {
    if ([...Deno.readDirSync(target)].length) fail(`${target} exists and is not empty`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  Deno.mkdirSync(target, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    Deno.writeTextFileSync(`${target}/${name}`, content);
  }
  console.log(`\n${ok("✓")} ${target}/ scaffolded:`);
  for (const name of Object.keys(files)) console.log(`    ${name}`);
  const todoFile = "agent.yaml" in files ? "agent.yaml" : "compose.yaml";
  console.log(
    `\nnext: fill in the TODOs in ${target}/${todoFile}, then follow ${target}/README.md`,
  );
}

// ---------- dispatch ----------

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
