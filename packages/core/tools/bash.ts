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
  let awaitRedirectTarget = false; // the next word is a redirection target, not a command
  let inSingle = false;
  let inDouble = false;

  const endWord = () => {
    if (!hasWord) return;
    // A redirection's target is a filename or fd, never an executable: `>out`,
    // and the `1` in `2>&1`, are consumed here, not checked against the allowlist.
    if (awaitRedirectTarget) {
      awaitRedirectTarget = false;
      word = "";
      hasWord = false;
      return;
    }
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
    // Redirections: the operator and its target name no command. `2>&1`, `>&2`,
    // `&>log` and friends must not leak a phantom executable — without this the
    // `&` reads as a separator and the fd or filename after it looks like the
    // next command (the reported `run access to "1"` denial). A lone `&` (no
    // `>` after) is still a separator, handled below.
    if (c === ">" || c === "<" || (c === "&" && command[i + 1] === ">")) {
      endWord(); // close the command word (`echo>x`) or fd number (`2>&1`) first
      while (i + 1 < command.length && "<>&".includes(command[i + 1])) i++; // >>, >&, &>>, <& …
      if (command[i + 1] === "|") i++; // >| clobber
      awaitRedirectTarget = true;
      continue;
    }
    // Segment separators: ; | newline, and & — both background (`a & b`) and
    // and-lists (`a && b`). A lone & must split like the others, or the command
    // after it (`gh ... & curl evil.com`) runs unchecked past the allowlist.
    if (c === ";" || c === "|" || c === "\n" || c === "&") {
      if (c === "&" && command[i + 1] === "&") i++; // consume the second &
      endWord();
      sawCommand = false;
      awaitRedirectTarget = false; // a new segment; any dangling redirect had no target
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
