/**
 * Advisories about `permissions.run` grants that weaken the permission model.
 *
 * run_bash checks the executable at the head of each pipe/chain segment
 * (extractExecutables, ../tools/bash.ts) and cannot see into arguments. A
 * grant on a program that runs *other* programs therefore collapses the
 * allowlist: `bash -c '<anything>'` passes the check with the real command
 * carried as an opaque string. Network-capable binaries are a different
 * weakening — subprocess traffic never touches `permissions.net`, so their
 * egress is bounded only by the container (Plan 6, gap 5).
 *
 * These are warnings, not refusals: the grants stay legal, the container
 * stays the backstop, and `af validate` / startup name what was given up.
 */

/** What a flagged `permissions.run` entry defeats. */
export type RunGrantHazard = "shell" | "wrapper" | "net";

/** One warning about a `permissions.run` entry. */
export interface RunGrantAdvisory {
  /** The allowlist entry the advisory is about. */
  entry: string;
  /** Which way the grant weakens the model. */
  hazard: RunGrantHazard;
  /** One printable line naming the entry and what it defeats. */
  advice: string;
}

/** Shells and interpreters: `-c` / `-e` / `run` execute an arbitrary program. */
const SHELLS_AND_INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "python",
  "python2",
  "python3",
  "node",
  "deno",
  "bun",
  "ruby",
  "perl",
  "php",
]);

/** Wrappers and exec flags: the real command travels in the arguments. */
const WRAPPERS = new Set([
  "env",
  "xargs",
  "nice",
  "nohup",
  "timeout",
  "setsid",
  "stdbuf",
  "sudo",
  "doas",
  "su",
  "find", // -exec
  "watch",
  "time",
  "npx",
]);

/** Binaries that open their own sockets, past `permissions.net`. */
const NETWORK_CAPABLE = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "telnet",
  "git",
  "gh",
]);

function adviseOn(entry: string): RunGrantAdvisory | undefined {
  if (entry === "*") {
    return {
      entry,
      hazard: "shell",
      advice: `permissions.run grants "*" — every executable, shells included; ` +
        `the allowlist no longer bounds what runs`,
    };
  }
  // The engine matches executables by basename, so judge the entry the same way.
  const base = entry.split("/").at(-1) ?? entry;
  if (SHELLS_AND_INTERPRETERS.has(base)) {
    return {
      entry,
      hazard: "shell",
      advice: `permissions.run grants "${entry}" — a shell/interpreter runs arbitrary commands ` +
        `(\`${base} -c '...'\`), so the allowlist no longer bounds what runs`,
    };
  }
  if (WRAPPERS.has(base)) {
    return {
      entry,
      hazard: "wrapper",
      advice: `permissions.run grants "${entry}" — it executes its arguments, ` +
        `carrying the real command past the allowlist`,
    };
  }
  if (NETWORK_CAPABLE.has(base)) {
    return {
      entry,
      hazard: "net",
      advice: `permissions.run grants "${entry}" — subprocess traffic bypasses permissions.net; ` +
        `its egress is bounded only by the container`,
    };
  }
  return undefined;
}

/**
 * Flag the `permissions.run` entries that quietly weaken the model, in the
 * order the config lists them. Advisory only — the lists name well-known
 * binaries, and a renamed copy of any of them would sail past; the point is
 * to catch the grants people write on purpose without seeing the cost.
 */
export function runGrantAdvisories(run: string[] | undefined): RunGrantAdvisory[] {
  const advisories: RunGrantAdvisory[] = [];
  for (const entry of run ?? []) {
    const advisory = adviseOn(entry);
    if (advisory) advisories.push(advisory);
  }
  return advisories;
}
