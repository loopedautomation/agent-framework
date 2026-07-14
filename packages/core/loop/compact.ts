import type { Message, Provider, Usage } from "../providers/types.ts";
import type { RunEvent } from "./loop.ts";

// Compaction: replace a conversation's older history with a model-written
// summary, keeping the most recent turns verbatim. One code path serves the
// /compact command and auto-compaction; the service owns persistence, this
// module owns the transcript surgery and the summarize call.

/**
 * First message of a compacted transcript. It keeps the wire format valid
 * (a transcript must not start with an assistant message) and marks the
 * summary that follows, so the next compaction knows to fold it forward.
 */
export const COMPACTION_MARKER =
  "[Earlier conversation compacted — the reply below summarizes everything before this point.]";

/**
 * Appended as the final user turn of the summarize call. Request-only and
 * never persisted, like the max-steps wrap-up prompt; the summary it
 * produces is what gets saved.
 */
export const COMPACTION_PROMPT =
  `Compact this conversation: write a summary that will replace the transcript above as your only memory of it, so you can continue seamlessly next time.

Cover, in short headed sections:
- Context: who you are talking with and what the conversation is about.
- Important details: facts, decisions, preferences, and constraints worth keeping. Preserve exact names, ids, numbers, dates, paths, and URLs verbatim.
- State: what has been done so far, including the outcomes of any tool use.
- Open items: anything unresolved or promised, and what the most recent exchange was about, so an immediate follow-up still makes sense.

Rules:
- If the transcript already begins with a compacted summary, fold its still-relevant facts into this one.
- Do not mention the compaction or summarizing process.
- Reply with the summary only — no preamble, no tool calls.`;

/** How many trailing user-turns survive a compaction verbatim. */
export const COMPACTION_KEEP_TURNS = 2;

/**
 * Split a transcript for compaction: `head` gets summarized, `tail` (the
 * last `keepTurns` user-turns, always starting at a user message so tool
 * sequences stay intact) survives verbatim.
 */
export function splitForCompaction(
  history: Message[],
  keepTurns: number = COMPACTION_KEEP_TURNS,
): { head: Message[]; tail: Message[] } {
  let start = history.length;
  let turns = 0;
  for (let i = history.length - 1; i >= 0 && turns < keepTurns; i--) {
    if (history[i].role === "user") {
      start = i;
      turns++;
    }
  }
  return { head: history.slice(0, start), tail: history.slice(start) };
}

/**
 * True when compacting would change nothing: everything is inside the kept
 * tail already, or the head is just a previous compaction's marker + summary
 * pair with no new messages before the tail.
 */
export function isNothingToCompact(history: Message[]): boolean {
  const { head } = splitForCompaction(history);
  if (head.length === 0) return true;
  return head.length === 2 && head[0].role === "user" &&
    head[0].content === COMPACTION_MARKER;
}

/** What one compaction produced: the replacement transcript and its cost. */
export interface CompactionResult {
  /** The replacement transcript: marker, summary, then the kept tail. */
  messages: Message[];
  /** Token usage of the summarize call. */
  usage: Usage;
}

/**
 * One tool-less summarize call over the transcript's head (the max-steps
 * wrap-up pattern), on the model the caller picked — `model.small`'s first
 * consumer. Returns undefined when there is nothing to compact or the model
 * produced an empty summary; the caller leaves the transcript untouched.
 * Provider errors propagate.
 */
export async function compactTranscript(opts: {
  provider: Provider;
  model: string;
  system: string;
  history: Message[];
  /** Observes progress for interactive surfaces; see {@linkcode RunEvent}. */
  onEvent?: (event: RunEvent) => void;
}): Promise<CompactionResult | undefined> {
  if (isNothingToCompact(opts.history)) return undefined;
  const { head, tail } = splitForCompaction(opts.history);
  opts.onEvent?.({ type: "compaction", phase: "start", messageCount: head.length });
  const completion = await opts.provider.complete({
    model: opts.model,
    system: opts.system,
    messages: [...head, { role: "user", content: COMPACTION_PROMPT }],
  });
  if (!completion.content.trim()) return undefined;
  return {
    messages: [
      { role: "user", content: COMPACTION_MARKER },
      { role: "assistant", content: completion.content },
      ...tail,
    ],
    usage: completion.usage,
  };
}
