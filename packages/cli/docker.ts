// Docker argv generation for af run/up/down/ps — pure functions, no side
// effects (the init.ts pattern: generation here, I/O in main.ts). The CLI
// never runs an agent on the host; these argv arrays ARE the deployment,
// the same commands docs/docker-run.md teaches by hand.

import { type AgentConfig, VERSION } from "@looped/core";

// Pinned to the CLI's own version, never :latest — docker won't re-pull a
// cached :latest, and a stale image blames the user's config with schema
// errors. A new CLI means a new tag, which guarantees a matching pull.
export const DEFAULT_IMAGE = `ghcr.io/loopedautomation/agent:${VERSION}`;

/** Containers are discovered by this label, never by name-guessing. */
export const LABEL = "af.agent";

export const containerName = (handle: string): string => `af-${handle}`;
export const volumeName = (handle: string): string => `${handle}-data`;

export type RunMode =
  | "interactive" // af run: -it --rm, REPL-capable
  | "attached" // af up (foreground): --rm, logs streamed
  | "detached"; // af up -d: -d --restart unless-stopped

export interface DockerRunOptions {
  mode: RunMode;
  /** Absolute path to the agent file on the host. */
  configPath: string;
  /** Absolute path to an env file; omit for none. */
  envFile?: string;
  image?: string;
  /** Allocate a TTY in interactive mode (off when stdin is piped). */
  tty?: boolean;
}

/** Lexically resolve "." and ".." so mount paths read like paths, not math. */
function normalize(path: string): string {
  const abs = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out.at(-1) !== "..") out.pop();
      else if (!abs) out.push(part); // absolute paths can't go above root
    } else out.push(part);
  }
  return abs ? `/${out.join("/")}` : out.join("/") || ".";
}

/** Host ports HTTP-serving triggers (webhook, tty) need published (container port = host port). */
export function webhookPorts(config: AgentConfig): number[] {
  return (config.triggers ?? [])
    .filter((t) => t.type === "webhook" || t.type === "tty")
    .map((t) => t.port);
}

/**
 * The full `docker run` argv for one agent. Mirrors the docs' hand-written
 * command: config mounted read-only, skills mounted at their config-relative
 * paths, a named /data volume so identity survives, status port on an
 * ephemeral loopback port (fleets never collide), read-only rootfs.
 */
export function dockerRunArgs(config: AgentConfig, opts: DockerRunOptions): string[] {
  const args = ["run"];
  switch (opts.mode) {
    case "interactive":
      args.push("-i");
      if (opts.tty !== false) args.push("-t");
      args.push("--rm");
      break;
    case "attached":
      args.push("--rm");
      break;
    case "detached":
      args.push("-d", "--restart", "unless-stopped");
      break;
  }
  args.push("--name", containerName(config.handle));
  args.push("--label", `${LABEL}=${config.handle}`);
  args.push("--label", `af.config=${opts.configPath}`);
  args.push("-v", `${opts.configPath}:/agent/agent.yaml:ro`);

  // Skills resolve relative to the config — recreate that layout under /agent.
  // (/agent/../../skills/x normalizes to /skills/x, which the sandbox reads.)
  const baseDir = opts.configPath.slice(0, opts.configPath.lastIndexOf("/"));
  for (const skill of config.skills ?? []) {
    args.push("-v", `${normalize(`${baseDir}/${skill}`)}:${normalize(`/agent/${skill}`)}:ro`);
  }

  args.push("-v", `${volumeName(config.handle)}:/data`);
  if (opts.envFile) args.push("--env-file", opts.envFile);

  // Status surface on an ephemeral loopback port; `docker port` reveals it.
  args.push("-p", "127.0.0.1:0:9090");
  for (const port of webhookPorts(config)) args.push("-p", `${port}:${port}`);

  args.push("--read-only", "--tmpfs", "/tmp");
  args.push(opts.image ?? DEFAULT_IMAGE);
  return args;
}

/** All af containers (running or stopped), one JSON object per line. */
export function dockerPsArgs(): string[] {
  return ["ps", "--all", "--filter", `label=${LABEL}`, "--format", "{{json .}}"];
}

/** Only running af containers for these handles (pre-flight collision check). */
export function dockerRunningArgs(handle: string): string[] {
  return ["ps", "--all", "-q", "--filter", `label=${LABEL}=${handle}`];
}

/** Graceful stop (SIGTERM, docker's grace period) — waits for exit. */
export function dockerStopArgs(handles: string[]): string[] {
  return ["stop", ...handles.map(containerName)];
}

/** Remove stopped containers; the /data volumes stay (identity is precious). */
export function dockerRmArgs(handles: string[]): string[] {
  return ["rm", ...handles.map(containerName)];
}

/** Ask docker where 127.0.0.1:0:9090 landed. */
export function dockerPortArgs(handle: string): string[] {
  return ["port", containerName(handle), "9090"];
}

/** One docker-ps JSON line, reduced to what `af ps` shows. */
export interface PsEntry {
  handle: string;
  state: string; // running | exited | ...
  status: string; // "Up 5 minutes" | "Exited (0) 2 hours ago"
  statusAddr?: string; // host addr of the 9090 mapping
}

export function parsePsLine(json: string): PsEntry | undefined {
  let row: Record<string, string>;
  try {
    row = JSON.parse(json);
  } catch {
    return undefined;
  }
  const label = (row.Labels ?? "").split(",").find((l) => l.startsWith(`${LABEL}=`));
  if (!label) return undefined;
  // Ports looks like "127.0.0.1:55031->9090/tcp, 8080/tcp"
  const addr = (row.Ports ?? "").split(",").map((p) => p.trim())
    .find((p) => p.endsWith("->9090/tcp"))?.split("->")[0];
  return {
    handle: label.slice(LABEL.length + 1),
    state: row.State ?? "",
    status: row.Status ?? "",
    statusAddr: addr,
  };
}
