// Shared reply-text helpers for chat triggers (Discord, Slack, Telegram).

/**
 * Sentinel reply for allow_silence: the agent answers with exactly this
 * string to signal "nothing to say", and the trigger posts nothing.
 */
export const NO_REPLY = "__NO_REPLY__";

/**
 * True when a reply means "stay silent": empty, or the NO_REPLY sentinel
 * surrounded by nothing but punctuation and whitespace. Cheap models often
 * append a trailing period or wrap the sentinel in quotes; that still counts.
 * A sentinel embedded in real content does not.
 */
export function isSilence(reply: string): boolean {
  if (reply === "") return true;
  const at = reply.indexOf(NO_REPLY);
  if (at === -1) return false;
  const rest = reply.slice(0, at) + reply.slice(at + NO_REPLY.length);
  return /^[\s\p{P}]*$/u.test(rest);
}

/**
 * Sentinels the agent leads a reply with to choose how it's delivered on a
 * voice-capable chat trigger. The default is to answer a voice note with a
 * voice note and text with text; these override it per reply. __VOICE__ asks
 * for the reply spoken as a voice note, __TEXT__ for plain text. Like
 * NO_REPLY, the agent has to be told about them; the trigger strips the marker
 * before delivering.
 */
export const VOICE_REPLY = "__VOICE__";
export const TEXT_REPLY = "__TEXT__";

/**
 * The delivery a reply asks for and the reply with its leading sentinel
 * removed. Only a marker at the very start counts (whitespace tolerated), so a
 * sentinel that turns up inside real content is left alone. `mode` is undefined
 * when neither leads, which tells the trigger to keep its incoming-modality
 * default.
 */
export function replyModality(
  reply: string,
): { mode: "voice" | "text" | undefined; text: string } {
  const lead = reply.trimStart();
  for (const [sentinel, mode] of [[VOICE_REPLY, "voice"], [TEXT_REPLY, "text"]] as const) {
    if (lead.startsWith(sentinel)) return { mode, text: lead.slice(sentinel.length).trim() };
  }
  return { mode: undefined, text: reply };
}

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
