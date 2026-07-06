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
  const executables: string[] = [];
  let word = "";
  let hasWord = false; // distinguishes "" (empty quoted word) from no word at all
  let sawCommand = false; // current segment already yielded its executable
  let inSingle = false;
  let inDouble = false;

  const endWord = () => {
    if (!hasWord) return;
    // Skip leading VAR=value assignments.
    if (!sawCommand && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      executables.push(word);
      sawCommand = true;
    }
    word = "";
    hasWord = false;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else word += c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      hasWord = true;
      continue;
    }
    // Substitution is live outside single quotes, including inside double quotes.
    if (
      c === "`" || (c === "$" && command[i + 1] === "(") ||
      (!inDouble && (c === "<" || c === ">") && command[i + 1] === "(")
    ) {
      return {
        ok: false,
        reason: "command substitution (`...`, $(...)) and process substitution are not permitted",
      };
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      else word += c;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      hasWord = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      hasWord = true;
      continue;
    }
    if (c === ";" || c === "|" || c === "\n" || (c === "&" && command[i + 1] === "&")) {
      if (c === "&") i++;
      endWord();
      sawCommand = false;
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      continue;
    }
    word += c;
    hasWord = true;
  }
  if (inSingle || inDouble) return { ok: false, reason: "unbalanced quotes" };
  endWord();
  if (executables.length === 0) return { ok: false, reason: "no command found" };
  return { ok: true, executables };
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? text.slice(0, MAX_OUTPUT_CHARS) + `\n[truncated at ${MAX_OUTPUT_CHARS} chars]`
    : text;
}

/** Options for {@linkcode createRunBashTool}. */
export interface RunBashOptions {
  /** Engine that decides which executables may run. */
  permissions: PermissionEngine;
  /**
   * The complete subprocess environment — only what the config granted,
   * plus PATH/HOME. No ambient inheritance: a spawned process must never
   * see secrets the agent.yaml didn't give it.
   */
  env: Record<string, string>;
  /** Working directory for the command. */
  cwd?: string;
  /** Kill the command after this long. Defaults to 60s. */
  timeoutMs?: number;
}

/** Build the run_bash native tool: executes allowlisted commands via bash -c. */
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
