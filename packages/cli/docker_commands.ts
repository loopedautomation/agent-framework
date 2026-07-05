// docker plumbing + the run/up/ps/down commands (af's docker frontend over @looped/core).

import { type AgentConfig, collectEnvRefs, resolveAgentConfig } from "@looped/core";
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

export const DEFAULT_CONFIG = "agent.yaml";

export function fail(message: string): never {
  console.error(`${red("error:")} ${message}`);
  Deno.exit(1);
}

export interface CommandFlags {
  detach: boolean;
  dryRun: boolean;
  image?: string;
  envFile?: string;
}

/** Positionals + the run/up/down flag set, from everything after the command. */
export function parseCommandArgs(tokens: string[]): { flags: CommandFlags; positional: string[] } {
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

/** af run — one agent, interactive, in the foreground (docker run -it --rm). */
export async function dockerRun(path: string, f: CommandFlags) {
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
export async function up(paths: string[], f: CommandFlags) {
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
export async function ps() {
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
export async function down(targets: string[]) {
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
