import { z } from "zod";
import { defineTool, type NativeTool } from "./types.ts";

// Native tool search: beyond a threshold, tool schemas stay out of context
// entirely — the model gets one search_tools schema instead of forty, and
// activates exactly what the task needs, mid-run. The manual alternative
// (MCP include: filtering) still exists; this is the automatic one.

/** Total tool count above which `auto` mode starts deferring MCP tools. */
export const SEARCH_AUTO_THRESHOLD = 10;

function score(query: string, tool: NativeTool): number {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  const name = tool.def.name.toLowerCase();
  const description = tool.def.description.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (name.includes(term)) total += 2;
    if (description.includes(term)) total += 1;
  }
  return total;
}

/**
 * Splits an agent's tools into always-active (natives, skills — small and
 * framework-owned) and deferred (typically MCP). Deferred tools are invisible
 * to the model until a search activates them; activation lasts for the rest
 * of the run.
 */
export class ToolRegistry {
  #always: NativeTool[];
  #deferred: NativeTool[];
  #activated = new Set<string>();
  #searchTool: NativeTool;

  constructor(always: NativeTool[], deferred: NativeTool[]) {
    this.#always = always;
    this.#deferred = deferred;
    this.#searchTool = defineTool({
      name: "search_tools",
      description:
        `Find more tools by keyword. ${deferred.length} additional tools are available ` +
        `but not yet loaded — search for what the task needs (e.g. "create issue", "calendar").`,
      schema: z.strictObject({ query: z.string().min(1) }),
      readOnly: true,
      execute: ({ query }) => this.#search(query),
    });
  }

  #search(query: string): string {
    const scored = this.#deferred
      .map((tool) => ({ tool, score: score(query, tool) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    // Relevance cutoff: a multi-term query mustn't activate every tool that
    // shares one common word ("create") with it.
    const ranked = scored.filter((r) => r.score >= scored[0]?.score / 2).slice(0, 5);
    if (!ranked.length) {
      return `no tools match "${query}". Available: ${
        this.#deferred.map((t) => t.def.name).join(", ")
      }`;
    }
    for (const { tool } of ranked) this.#activated.add(tool.def.name);
    return "now available:\n" +
      ranked.map(({ tool }) => `- ${tool.def.name}: ${tool.def.description}`).join("\n");
  }

  /** The current toolset — call per loop iteration; grows as searches activate tools. */
  active(): NativeTool[] {
    const activated = this.#deferred.filter((t) => this.#activated.has(t.def.name));
    return this.#deferred.length
      ? [...this.#always, this.#searchTool, ...activated]
      : [...this.#always];
  }
}
