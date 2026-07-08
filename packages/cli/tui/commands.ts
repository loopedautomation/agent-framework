// Slash commands for the REPL — the dropdown's view of the command system.
// The agent-level commands (built-ins plus config-defined) come from core
// and run inside AgentService.handle(), the same interception every trigger
// gets (plan 010). The REPL adds two of its own that only make sense on a
// screen, and handles just those itself.

import { type CommandConfig, type CommandSpec, commandSpecs } from "@looped/core";

/** One REPL command, as shown in /help and the dropdown. */
export type SlashCommand = CommandSpec;

/** The commands the REPL handles itself — they exist only on this surface. */
export const LOCAL_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "Clear the screen" },
  { name: "exit", description: "Leave the REPL" },
];

/**
 * The dropdown's wording for the built-ins. Core's descriptions are written
 * for the platform pickers; the dropdown wants them terse, and /help here
 * also covers the keys.
 */
const REPL_DESCRIPTIONS: Record<string, string> = {
  help: "List commands and keys",
  status: "Agent, model and session facts",
  reset: "Clear this conversation's history",
};

/** Everything the dropdown offers: the agent's commands, then the REPL's own. */
export function replCommands(configured?: CommandConfig[]): SlashCommand[] {
  const agent = commandSpecs(configured).map((c) => ({
    ...c,
    description: REPL_DESCRIPTIONS[c.name] ?? c.description,
  }));
  return [...agent, ...LOCAL_COMMANDS];
}

/**
 * The dropdown's contents for the line as typed: commands whose names start
 * with what follows the slash. Empty once arguments begin (first space) or
 * when the line isn't a slash line at all.
 */
export function completions(line: string, commands: SlashCommand[]): SlashCommand[] {
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
