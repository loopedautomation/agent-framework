import { assert, assertEquals } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { mcpToolsFromClient } from "./mcp.ts";

async function testClient(): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  server.registerTool("create_issue", {
    description: "Create an issue",
    inputSchema: { title: z.string() },
  }, ({ title }: { title: string }) => ({
    content: [{ type: "text" as const, text: `created: ${title}` }],
  }));
  server.registerTool("delete_repo", {
    description: "Danger",
    inputSchema: {},
  }, () => ({ content: [{ type: "text", text: "gone" }] }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

Deno.test("mcp tools: namespaced, filtered by include, round-trip", async () => {
  const client = await testClient();
  const tools = await mcpToolsFromClient(client, "github", ["create_issue"]);

  // include filtering: delete_repo never becomes a tool
  assertEquals(tools.map((t) => t.def.name), ["mcp__github__create_issue"]);

  const result = await tools[0].execute(JSON.stringify({ title: "CSV export bug" }));
  assertEquals(result, "created: CSV export bug");

  const bad = await tools[0].execute("{nope");
  assert(bad.includes("invalid arguments"));
  await client.close();
});
