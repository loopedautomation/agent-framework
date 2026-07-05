import { z } from "zod";
import type { MemoryRecord, Store } from "../store/store.ts";
import { defineTool, type NativeTool } from "./types.ts";

const MAX_LIST_CHARS = 4_000;

/**
 * Progressive disclosure, mirroring skills: the system prompt carries a
 * cheap index of what the agent already remembers, so a small model knows
 * to check before asking the operator to repeat themselves.
 */
export function memoryPromptSection(memories: MemoryRecord[]): string {
  if (!memories.length) return "";
  const lines = memories.map((m) => `- ${m.key}`).join("\n");
  return `\n\nYou have persistent memory — facts and preferences that survive across ` +
    `conversations and restarts. Use recall to read one, list_memories to browse, remember ` +
    `to save or update one, forget to delete one. Keys you already have:\n${lines}`;
}

/** A memory write or delete, for the audit trail. */
export interface MemoryEvent {
  /** Which tool caused the event. */
  action: "remember" | "forget";
  /** The key affected. */
  key: string;
}

/**
 * Build the remember/recall/list_memories/forget native tools over an
 * agent's own store. `onEvent`, when given, fires on every write/delete so
 * the caller can land it in the audit trail (writes only — recall and
 * list_memories are read-only and don't need auditing).
 */
export function createMemoryTools(
  store: Store,
  onEvent?: (event: MemoryEvent) => void,
): NativeTool[] {
  const remember = defineTool({
    name: "remember",
    description:
      "Save or update a fact under a key, persisted across conversations and restarts. " +
      "Overwrites any existing value for the same key.",
    schema: z.strictObject({ key: z.string().min(1), value: z.string().min(1) }),
    readOnly: false,
    execute({ key, value }) {
      store.rememberMemory(key, value);
      onEvent?.({ action: "remember", key });
      return `remembered ${key}`;
    },
  });

  const recall = defineTool({
    name: "recall",
    description: "Read a previously remembered fact by key.",
    schema: z.strictObject({ key: z.string().min(1) }),
    readOnly: true,
    execute({ key }) {
      const memory = store.recallMemory(key);
      if (!memory) return `no memory under key: ${key}`;
      return memory.value;
    },
  });

  const listMemories = defineTool({
    name: "list_memories",
    description: "List all remembered keys and values.",
    schema: z.strictObject({}),
    readOnly: true,
    execute() {
      const memories = store.listMemories();
      if (!memories.length) return "no memories yet";
      const text = memories.map((m) => `${m.key}: ${m.value}`).join("\n");
      return text.length > MAX_LIST_CHARS
        ? text.slice(0, MAX_LIST_CHARS) + `\n[truncated at ${MAX_LIST_CHARS} chars]`
        : text;
    },
  });

  const forget = defineTool({
    name: "forget",
    description: "Delete a remembered fact by key.",
    schema: z.strictObject({ key: z.string().min(1) }),
    readOnly: false,
    execute({ key }) {
      const removed = store.forgetMemory(key);
      if (removed) onEvent?.({ action: "forget", key });
      return removed ? `forgot ${key}` : `no memory under key: ${key}`;
    },
  });

  return [remember, recall, listMemories, forget];
}
