// Shared reply-text helpers for chat triggers (Discord, Slack, Telegram).

/**
 * Sentinel reply for allow_silence: the agent answers with exactly this
 * string to signal "nothing to say", and the trigger posts nothing.
 */
export const NO_REPLY = "__NO_REPLY__";

/** Chat platforms cap message length; split on line boundaries where possible. */
export function splitMessage(text: string, limit = 2000): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
