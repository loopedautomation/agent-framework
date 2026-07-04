import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import type { Completion, CompletionRequest, Provider } from "../providers/types.ts";
import { parseAgentConfig } from "../config/load.ts";
import { runAgent } from "../loop/loop.ts";
import { defineTool, type NativeTool } from "./types.ts";
import { ToolRegistry } from "./registry.ts";

function fakeTool(name: string, description: string): NativeTool {
  return defineTool({
    name,
    description,
    schema: z.strictObject({}),
    readOnly: true,
    execute: () => `${name} ran`,
  });
}

const NATIVE = fakeTool("current_time", "Get the current time.");
const DEFERRED = [
  fakeTool("mcp__github__create_issue", "Create a GitHub issue."),
  fakeTool("mcp__github__close_issue", "Close a GitHub issue."),
  fakeTool("mcp__calendar__create_event", "Create a calendar event."),
];

Deno.test("deferred tools are invisible until a search activates them", async () => {
  const registry = new ToolRegistry([NATIVE], DEFERRED);

  const before = registry.active().map((t) => t.def.name);
  assertEquals(before, ["current_time", "search_tools"]);

  const search = registry.active().find((t) => t.def.name === "search_tools")!;
  const result = await search.execute(JSON.stringify({ query: "create github issue" }));
  assert(result.includes("mcp__github__create_issue"));

  const after = registry.active().map((t) => t.def.name);
  assert(after.includes("mcp__github__create_issue")); // activated, stays active
  assert(!after.includes("mcp__calendar__create_event")); // unrelated stays deferred
});

Deno.test("no matches lists what exists instead of failing silently", async () => {
  const registry = new ToolRegistry([NATIVE], DEFERRED);
  const search = registry.active().find((t) => t.def.name === "search_tools")!;
  const result = await search.execute(JSON.stringify({ query: "zzzzz" }));
  assert(result.includes("no tools match"));
  assert(result.includes("mcp__github__create_issue"));
});

Deno.test("no deferred tools → no search tool", () => {
  const registry = new ToolRegistry([NATIVE], []);
  assertEquals(registry.active().map((t) => t.def.name), ["current_time"]);
});

Deno.test("loop picks up tools activated by search on the next step", async () => {
  const registry = new ToolRegistry([], DEFERRED);
  const config = parseAgentConfig(
    `handle: search-bot\ndescription: d\nmodel:\n  provider: openai-compatible\n  id: m\npurpose: p`,
  );
  // Step 1: model searches. Step 2: model calls the newly activated tool.
  // Step 3: done. The provider asserts the tool surface it was shown.
  const surfaces: string[][] = [];
  let step = 0;
  const provider: Provider = {
    id: "mock",
    complete(req: CompletionRequest): Promise<Completion> {
      surfaces.push((req.tools ?? []).map((t) => t.name));
      step++;
      const respond = (toolCalls: Completion["toolCalls"], content = ""): Completion => ({
        content,
        toolCalls,
        stopReason: toolCalls.length ? "tool_calls" : "end",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      if (step === 1) {
        return Promise.resolve(respond([{
          id: "s1",
          name: "search_tools",
          arguments: '{"query":"github issue"}',
        }]));
      }
      if (step === 2) {
        return Promise.resolve(respond([{
          id: "c1",
          name: "mcp__github__create_issue",
          arguments: "{}",
        }]));
      }
      return Promise.resolve(respond([], "created"));
    },
  };

  const result = await runAgent({
    config,
    provider,
    tools: () => registry.active(),
    input: "make an issue",
  });
  assertEquals(result.status, "ok");
  assertEquals(surfaces[0], ["search_tools"]); // schemas deferred at step 1
  assert(surfaces[1].includes("mcp__github__create_issue")); // activated by step 2
  const toolMsg = result.messages.filter((m) => m.role === "tool");
  assertEquals(toolMsg[1].content, "mcp__github__create_issue ran");
});
