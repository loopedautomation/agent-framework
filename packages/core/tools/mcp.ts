import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentConfig } from "../config/schema.ts";
import { resolveEnv } from "../config/env.ts";
import type { NativeTool } from "./types.ts";

const MAX_RESULT_CHARS = 8_000;

/** Live MCP connections: the tools they provide and a way to shut them down. */
export interface McpConnections {
  /** Tools from all connected servers, namespaced mcp__<server>__<tool>. */
  tools: NativeTool[];
  /** Close every client connection. */
  close(): Promise<void>;
}

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS
    ? text.slice(0, MAX_RESULT_CHARS) + `\n[truncated at ${MAX_RESULT_CHARS} chars]`
    : text;
}

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((block) =>
      block?.type === "text" ? block.text : `[${block?.type ?? "unknown"} content omitted]`
    )
    .join("\n");
}

/**
 * Map a connected MCP client's tools into namespaced NativeTools:
 * `mcp__<server>__<tool>`, so permission rules and logs treat them
 * uniformly. `include` filters a fat server down to what the agent
 * actually needs — no dead schemas burning a small model's context.
 * `readonlyOnly` keeps only tools whose readOnlyHint annotation marks
 * them read-only (the hint is self-reported by the server).
 */
export async function mcpToolsFromClient(
  client: Client,
  serverName: string,
  include?: string[],
  readonlyOnly?: boolean,
): Promise<NativeTool[]> {
  interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: { readOnlyHint?: boolean };
  }
  const { tools } = await client.listTools() as { tools: McpToolInfo[] };
  let wanted = include ? tools.filter((t: McpToolInfo) => include.includes(t.name)) : tools;
  if (readonlyOnly) {
    wanted = wanted.filter((t: McpToolInfo) => t.annotations?.readOnlyHint === true);
  }
  return wanted.map((tool: McpToolInfo) => ({
    def: {
      name: `mcp__${serverName}__${tool.name}`,
      description: tool.description ?? tool.name,
      inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      readOnly: tool.annotations?.readOnlyHint ?? false,
    },
    execute: async (rawArgs: string): Promise<string> => {
      let args: Record<string, unknown>;
      try {
        args = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
      } catch {
        return "invalid arguments: not valid JSON";
      }
      try {
        const result = await client.callTool({ name: tool.name, arguments: args });
        const text = truncate(contentToText(result.content));
        return result.isError ? `tool error: ${text}` : text;
      } catch (err) {
        return `tool error: ${(err as Error).message}`;
      }
    },
  }));
}

/** One MCP tool call, as recorded to the audit trail. */
export interface McpCallRecord {
  /** The namespaced tool name, mcp__<server>__<tool>. */
  tool: string;
  /** Whether the call returned a normal result (false on tool errors and invalid arguments). */
  ok: boolean;
}

/**
 * Wrap MCP tools so every call is reported to `record` — MCP calls land in
 * the same audit trail as permission decisions, so a transcript is never
 * the only record of what an agent did over MCP.
 */
export function withMcpAudit(
  tools: NativeTool[],
  record: (call: McpCallRecord) => void,
): NativeTool[] {
  return tools.map((tool) => ({
    def: tool.def,
    execute: async (rawArgs: string): Promise<string> => {
      const result = await tool.execute(rawArgs);
      record({
        tool: tool.def.name,
        ok: !(result.startsWith("tool error") || result.startsWith("invalid arguments")),
      });
      return result;
    },
  }));
}

/** Connect every MCP server the config declares and collect their tools. */
export async function connectMcpServers(config: AgentConfig): Promise<McpConnections> {
  const clients: Client[] = [];
  const tools: NativeTool[] = [];
  for (const server of config.tools?.mcp ?? []) {
    const client = new Client({ name: "looped-af", version: "0.1.0" });
    if (server.command) {
      const [command, ...args] = server.command;
      await client.connect(
        new StdioClientTransport({
          command,
          args,
          // Scoped: the server sees only what its env block grants.
          env: resolveEnv(server.env),
        }),
      );
    } else {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url!)));
    }
    clients.push(client);
    tools.push(...await mcpToolsFromClient(client, server.name, server.include, server.readonly));
  }
  return {
    tools,
    close: async () => {
      for (const client of clients) await client.close();
    },
  };
}
