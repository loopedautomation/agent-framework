import type { CommandConfig } from "../config/schema.ts";

// Slash commands (Plan 10): a deterministic path for small operator actions.
// Parsing is strict on purpose — a leading "/" followed by an exact known
// command name. Everything else falls through to the model untouched, so a
// pasted file path or a conversational "/shrug" never gets eaten.

/** A command's operator-facing surface: what /help lists and platforms register. */
export interface CommandSpec {
  /** The name typed after the slash. */
  name: string;
  /** One line: what the command does. */
  description: string;
}

/** The commands every agent answers, no config required. */
export const BUILTIN_COMMANDS: CommandSpec[] = [
  { name: "help", description: "List the commands this agent responds to." },
  {
    name: "status",
    description: "Report the agent's identity, model, uptime, and run totals.",
  },
  {
    name: "reset",
    description: "Clear this conversation's history. Persistent memories survive.",
  },
];

/** A recognized slash command, split into name and trailing arguments. */
export interface ParsedCommand {
  /** The matched command name, without the slash. */
  name: string;
  /** Everything after the name, trimmed; empty when the command stands alone. */
  args: string;
}

/**
 * Strict slash-command parser (pure, unit-tested): the trimmed input must be
 * a "/" followed by an exact known name, optionally followed by whitespace
 * and arguments. Anything else returns undefined and reaches the model.
 */
export function parseCommand(
  input: string,
  known: readonly string[],
): ParsedCommand | undefined {
  const text = input.trim();
  if (!text.startsWith("/")) return undefined;
  const space = text.search(/\s/);
  const name = (space === -1 ? text : text.slice(0, space)).slice(1);
  if (!known.includes(name)) return undefined;
  const args = space === -1 ? "" : text.slice(space).trim();
  return { name, args };
}

/** Every command an agent answers: built-ins first, then the config-defined ones. */
export function commandSpecs(configured: CommandConfig[] = []): CommandSpec[] {
  return [
    ...BUILTIN_COMMANDS,
    ...configured.map(({ name, description }) => ({ name, description })),
  ];
}

/** Substitute the command's arguments into a config-defined prompt template. */
export function substituteArgs(prompt: string, args: string): string {
  return prompt.replaceAll("$ARGS", args);
}

/** The /help reply: one line per command. */
export function helpText(specs: CommandSpec[]): string {
  return specs.map((c) => `/${c.name} — ${c.description}`).join("\n");
}
