import { z } from "zod";
import type { PermissionEngine } from "../permissions/engine.ts";
import { defineTool, type NativeTool } from "./types.ts";

const MAX_OUTPUT_CHARS = 8_000;

/**
 * Statically extract the executables a shell command would run so they can
 * be checked against permissions.run. Constructs we can't reason about
 * statically (command substitution, process substitution) are rejected
 * outright — an unattended agent gets a clear denial, not a maybe.
 */
export function extractExecutables(command: string): { ok: true; executables: string[] } | {
  ok: false;
  reason: string;
} {
  if (/[`]|\$\(|<\(|>\(/.test(command)) {
    return {
      ok: false,
      reason: "command substitution (`...`, $(...)) and process substitution are not permitted",
    };
  }
  const executables: string[] = [];
  for (const segment of command.split(/\|\||&&|;|\||\n/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    // Skip leading VAR=value assignments.
    const cmd = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (cmd) executables.push(cmd);
  }
  if (executables.length === 0) return { ok: false, reason: "no command found" };
  return { ok: true, executables };
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? text.slice(0, MAX_OUTPUT_CHARS) + `\n[truncated at ${MAX_OUTPUT_CHARS} chars]`
    : text;
}

export interface RunBashOptions {
  permissions: PermissionEngine;
  /**
   * The complete subprocess environment — only what the config granted,
   * plus PATH/HOME. No ambient inheritance: a spawned process must never
   * see secrets the agent.yaml didn't give it.
   */
  env: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export function createRunBashTool(opts: RunBashOptions): NativeTool {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return defineTool({
    name: "run_bash",
    description:
      "Run a bash command and return its stdout/stderr. Only executables in the agent's run allowlist are permitted.",
    schema: z.strictObject({ command: z.string().min(1) }),
    async execute({ command }) {
      const extracted = extractExecutables(command);
      if (!extracted.ok) return `permission denied: ${extracted.reason}`;
      for (const executable of extracted.executables) {
        const decision = opts.permissions.run(executable);
        if (!decision.allowed) return decision.reason!;
      }

      const child = new Deno.Command("bash", {
        args: ["-c", command],
        env: { PATH: Deno.env.get("PATH") ?? "", HOME: Deno.env.get("HOME") ?? "", ...opts.env },
        clearEnv: true,
        cwd: opts.cwd,
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      try {
        const { code, stdout, stderr } = await child.output();
        const out = truncate(new TextDecoder().decode(stdout));
        const err = truncate(new TextDecoder().decode(stderr));
        return JSON.stringify({ exit_code: code, stdout: out, stderr: err });
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
