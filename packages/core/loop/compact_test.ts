import { assert, assertEquals } from "@std/assert";
import type { Completion, CompletionRequest, Provider } from "../providers/types.ts";
import {
  COMPACTION_MARKER,
  COMPACTION_PROMPT,
  compactTranscript,
  isNothingToCompact,
  splitForCompaction,
} from "./compact.ts";
import type { Message } from "../providers/types.ts";

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });

// Four turns; the third includes a tool sequence that must never be split.
const FOUR_TURNS: Message[] = [
  user("one"),
  assistant("re: one"),
  user("two"),
  assistant("re: two"),
  user("three"),
  { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "x", arguments: "{}" }] },
  { role: "tool", toolCallId: "t1", content: "result" },
  assistant("re: three"),
  user("four"),
  assistant("re: four"),
];

function fakeProvider(reply: string): { provider: Provider; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const provider: Provider = {
    id: "fake",
    complete(req: CompletionRequest): Promise<Completion> {
      calls.push(req);
      return Promise.resolve({
        content: reply,
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 42, outputTokens: 7 },
      });
    },
  };
  return { provider, calls };
}

Deno.test("splitForCompaction keeps the last turns, sliced at a user boundary", () => {
  const { head, tail } = splitForCompaction(FOUR_TURNS);
  // The kept tail starts at "three", so its tool sequence stays intact.
  assertEquals(head.map((m) => m.content), ["one", "re: one", "two", "re: two"]);
  assertEquals(tail[0].content, "three");
  assertEquals(tail.length, 6);
});

Deno.test("splitForCompaction with fewer turns than the keep count summarizes nothing", () => {
  const short = FOUR_TURNS.slice(0, 4); // two turns exactly
  const { head, tail } = splitForCompaction(short);
  assertEquals(head, []);
  assertEquals(tail.length, 4);
});

Deno.test("isNothingToCompact: short transcripts and freshly compacted ones", () => {
  assert(isNothingToCompact([]));
  assert(isNothingToCompact(FOUR_TURNS.slice(0, 4))); // everything fits the tail
  // A compacted transcript plus up to two turns has nothing new before the tail.
  const compacted = [
    user(COMPACTION_MARKER),
    assistant("the summary"),
    user("five"),
    assistant("re: five"),
  ];
  assert(isNothingToCompact(compacted));
  // A third turn pushes the marker pair plus a turn into the head — compactable.
  assert(!isNothingToCompact([...compacted, user("six"), assistant("re: six"), user("seven")]));
  assert(!isNothingToCompact(FOUR_TURNS));
});

Deno.test("compactTranscript summarizes the head and keeps the tail verbatim", async () => {
  const { provider, calls } = fakeProvider("a fine summary");
  const result = await compactTranscript({
    provider,
    model: "small-model",
    system: "You are terse.",
    history: FOUR_TURNS,
  });
  assert(result);

  // The call: head + the compaction prompt as the final user turn, no tools.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].model, "small-model");
  assertEquals(calls[0].system, "You are terse.");
  assertEquals(calls[0].tools, undefined);
  assertEquals(calls[0].messages.at(-1), { role: "user", content: COMPACTION_PROMPT });
  assertEquals(calls[0].messages.length, 5); // 4 head messages + the prompt

  // The replacement: marker, summary, then the tail from "three" onward.
  assertEquals(result.messages[0], { role: "user", content: COMPACTION_MARKER });
  assertEquals(result.messages[1], { role: "assistant", content: "a fine summary" });
  assertEquals(result.messages[2].content, "three");
  assertEquals(result.messages.length, 8);
  assertEquals(result.usage, { inputTokens: 42, outputTokens: 7 });
});

Deno.test("compactTranscript declines when there is nothing to compact or no summary", async () => {
  const { provider, calls } = fakeProvider("unused");
  const short = await compactTranscript({
    provider,
    model: "m",
    system: "s",
    history: FOUR_TURNS.slice(0, 4),
  });
  assertEquals(short, undefined);
  assertEquals(calls.length, 0); // declined before spending a call

  const empty = fakeProvider("   ");
  const blank = await compactTranscript({
    provider: empty.provider,
    model: "m",
    system: "s",
    history: FOUR_TURNS,
  });
  assertEquals(blank, undefined);
  assertEquals(empty.calls.length, 1); // spent the call, kept the transcript
});
