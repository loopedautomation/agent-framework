import { assert, assertEquals } from "@std/assert";
import { Store } from "../store/store.ts";
import { createMemoryTools, type MemoryEvent, memoryPromptSection } from "./memory.ts";

function tools(onEvent?: (event: MemoryEvent) => void) {
  const store = new Store(":memory:");
  const [remember, recall, listMemories, forget] = createMemoryTools(store, onEvent);
  return { store, remember, recall, listMemories, forget };
}

Deno.test("remember/recall/forget round-trip", async () => {
  const { remember, recall, forget } = tools();
  assertEquals(
    await recall.execute(JSON.stringify({ key: "color" })),
    "no memory under key: color",
  );
  assertEquals(
    await remember.execute(JSON.stringify({ key: "color", value: "blue" })),
    "remembered color",
  );
  assertEquals(await recall.execute(JSON.stringify({ key: "color" })), "blue");
  assertEquals(
    await remember.execute(JSON.stringify({ key: "color", value: "green" })),
    "remembered color",
  );
  assertEquals(await recall.execute(JSON.stringify({ key: "color" })), "green");
  assertEquals(await forget.execute(JSON.stringify({ key: "color" })), "forgot color");
  assertEquals(
    await recall.execute(JSON.stringify({ key: "color" })),
    "no memory under key: color",
  );
});

Deno.test("list_memories shows everything remembered", async () => {
  const { remember, listMemories } = tools();
  assertEquals(await listMemories.execute("{}"), "no memories yet");
  await remember.execute(JSON.stringify({ key: "color", value: "blue" }));
  await remember.execute(JSON.stringify({ key: "timezone", value: "UTC" }));
  const result = await listMemories.execute("{}");
  assert(result.includes("color: blue"));
  assert(result.includes("timezone: UTC"));
});

Deno.test("writes and deletes fire onEvent for the audit trail; reads don't", async () => {
  const events: MemoryEvent[] = [];
  const { remember, recall, forget } = tools((e) => events.push(e));
  await remember.execute(JSON.stringify({ key: "color", value: "blue" }));
  await recall.execute(JSON.stringify({ key: "color" }));
  await forget.execute(JSON.stringify({ key: "color" }));
  await forget.execute(JSON.stringify({ key: "color" })); // no-op: nothing to forget
  assertEquals(events, [
    { action: "remember", key: "color" },
    { action: "forget", key: "color" },
  ]);
});

Deno.test("memoryPromptSection lists keys cheaply, empty when there's nothing yet", () => {
  assertEquals(memoryPromptSection([]), "");
  const section = memoryPromptSection([
    { key: "color", value: "blue", createdAt: "now", updatedAt: "now" },
  ]);
  assert(section.includes("- color"));
  assert(!section.includes("blue")); // values stay out of the prompt; recall fetches them
});
