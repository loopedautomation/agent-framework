import { redactText } from "../redact/redact.ts";

/**
 * The agent's log surface. Everything the runtime and its triggers print goes
 * through here, because the things worth logging — a failed API call, a
 * schedule's reply, an MCP server's stderr — are exactly the things that quote
 * a secret back at you. Redaction happens on the way out, so no call site has
 * to remember.
 */
export function logInfo(message: string): void {
  console.log(redactText(message));
}

/** Log a warning; secrets are scrubbed. */
export function logWarn(message: string): void {
  console.warn(redactText(message));
}

/** Log an error; secrets are scrubbed. */
export function logError(message: string): void {
  console.error(redactText(message));
}
