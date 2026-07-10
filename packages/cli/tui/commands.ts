// Slash commands for the REPL — the parser and the dropdown's view of it.
// Pure functions, per plan 010: strict parsing, and anything that isn't an
// exact known command falls through to the model untouched.

/** One REPL command, as shown in /help and the dropdown. */
export interface SlashCommand {
  /** The name typed after the slash. */
  name: string;
  /** One line for the dropdown and /help. */
  description: string;
}

/** The REPL's built-ins. */
export const COMMANDS: SlashCommand[] = [
  { name: "help", description: "List commands and keys" },
  { name: "status", description: "Agent, model and session facts" },
  { name: "reset", description: "Clear this conversation's history" },
  { name: "clear", description: "Clear the screen" },
  { name: "exit", description: "Leave the REPL" },
];

/**
 * The dropdown's contents for the line as typed: commands whose names start
 * with what follows the slash. Empty once arguments begin (first space) or
 * when the line isn't a slash line at all.
 */
export function completions(line: string, commands: SlashCommand[] = COMMANDS): SlashCommand[] {
  if (!line.startsWith("/") || line.includes(" ")) return [];
  const prefix = line.slice(1).toLowerCase();
  return commands.filter((c) => c.name.startsWith(prefix));
}

/**
 * Split a slash line into name and args. Returns null for non-slash lines;
 * the caller checks the name against known commands and lets everything
 * unknown fall through to the model.
 */
export function parseSlash(line: string): { name: string; args: string } | null {
  const m = line.trim().match(/^\/(\S+)(?:\s+(.*))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: m[2]?.trim() ?? "" };
}
