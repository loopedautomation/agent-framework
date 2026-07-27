// Scoped env keeps a secret out of the model's initial context. These tests
// cover the other half: a permitted CLI, MCP server, HTTP body or provider
// error can all echo one back, and none of those may reach the model, the
// database, the status API or the logs.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { REDACTED, Redactor, redactorForConfig } from "./redact.ts";
import { parseAgentConfig } from "../config/load.ts";
import { PermissionEngine } from "../permissions/engine.ts";
import { createHttpRequestTool } from "../tools/http.ts";
import { mcpToolsFromClient } from "../tools/mcp.ts";
import { Store } from "../store/store.ts";
import { runAgent } from "../loop/loop.ts";
import { AgentService } from "../runtime/service.ts";
import type { Completion, CompletionRequest, Provider } from "../providers/types.ts";
import { ProviderError } from "../providers/types.ts";

const SECRET = "sk-live-51H8xQ2eZvKYlo2C";

Deno.test("redactor: substitutes a secret in every encoding it can travel in", () => {
  const r = new Redactor({ values: [SECRET] });

  assertEquals(r.text(`token is ${SECRET} ok`), `token is ${REDACTED} ok`);
  // A query string carries it URL-encoded; a Basic auth header, base64.
  const withSlash = new Redactor({ values: ["pa/ss word+1"] });
  assertEquals(withSlash.text(encodeURIComponent("pa/ss word+1")), REDACTED);
  assertEquals(withSlash.text(btoa("pa/ss word+1")), REDACTED);
  // A tool that serialized it into JSON escaped the quotes, not the value.
  assertEquals(r.text(JSON.stringify({ key: SECRET })), `{"key":"${REDACTED}"}`);
});

Deno.test("redactor: short values are left alone, so env: {DEBUG: 1} shreds nothing", () => {
  const r = new Redactor({ values: ["1", "true", "", undefined] });
  assert(!r.active);
  assertEquals(r.text("1 true thing"), "1 true thing");
});

Deno.test("redactor: credential fields are dropped by name, whatever they hold", () => {
  const r = new Redactor({ headers: ["x-looped-signature"] });

  const cleaned = r.deep({
    headers: { Authorization: "Bearer whatever-this-is", "Content-Type": "application/json" },
    nested: [{ "x-looped-signature": "abc123", keep: "visible" }],
    cookie: "session=1",
  });

  assertEquals(cleaned, {
    headers: { Authorization: REDACTED, "Content-Type": "application/json" },
    nested: [{ "x-looped-signature": REDACTED, keep: "visible" }],
    cookie: REDACTED,
  });
});

Deno.test("redactor: jsonText reaches credential fields inside a serialized tool result", () => {
  const r = new Redactor();
  const result = JSON.stringify({ status: 200, body: { headers: { authorization: "Bearer x" } } });
  assertStringIncludes(r.jsonText(result), REDACTED);
  // Not JSON: still a string, still returned.
  assertEquals(r.jsonText("plain output"), "plain output");
});

Deno.test("redactorForConfig: seeded from every env var the config references", () => {
  const config = parseAgentConfig(`
handle: seeded-bot
description: seeding test
model:
  provider: anthropic
  id: claude-sonnet-5
purpose: You do a job.
triggers:
  - type: telegram
    token_env: TELEGRAM_TOKEN
permissions:
  net: [api.stripe.com]
env:
  GITHUB_TOKEN: \${GH_TOKEN}
  LOG_LEVEL: debug
http:
  auth:
    - url: https://api.stripe.com
      value: Bearer \${STRIPE_KEY}
redact:
  values: ["\${BAKED_IN}"]
`);

  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: "anthropic-key-value",
    TELEGRAM_TOKEN: "telegram-token-value",
    GH_TOKEN: "github-token-value",
    STRIPE_KEY: "stripe-key-value",
    BAKED_IN: "baked-in-value",
  };
  const r = redactorForConfig(config, { getEnv: (n) => env[n], secretsDir: "/nonexistent" });

  // The model's key, the trigger's token, the scoped env ref, the http
  // credential's ref and the extra value all resolve and all get scrubbed.
  for (const value of Object.values(env)) {
    assertEquals(r.text(`leaked ${value}`), `leaked ${REDACTED}`);
  }
  // A literal in the config is committed to the repo, so it is not a secret —
  // redacting it would shred ordinary output for nothing.
  assertEquals(r.text("LOG_LEVEL=debug"), "LOG_LEVEL=debug");
});

Deno.test("redaction: bash cannot echo a scoped secret back through a whole run", async () => {
  const config = parseAgentConfig(`
handle: bash-bot
description: bash redaction
model:
  provider: openai-compatible
  id: test-model
purpose: You run commands.
memory:
  scope: thread
permissions:
  run: [printenv]
env:
  API_TOKEN: ${SECRET}
`);
  // The model calls a permitted command that does exactly what it says, then
  // repeats what it saw. Everything downstream of that must be clean.
  let call = 0;
  const provider: Provider = {
    id: "stub",
    complete: (req: CompletionRequest): Promise<Completion> => {
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (call++ === 0) {
        return Promise.resolve({
          content: "",
          toolCalls: [{
            id: "1",
            name: "run_bash",
            arguments: JSON.stringify({ command: "printenv API_TOKEN" }),
          }],
          stopReason: "tool_calls",
          usage,
        });
      }
      // Whatever the model reports back, it can only report what it was given.
      const saw = req.messages.find((m) => m.role === "tool")!.content;
      return Promise.resolve({
        content: `the token is ${saw}`,
        toolCalls: [],
        stopReason: "end",
        usage,
      });
    },
  };

  const dataDir = await Deno.makeTempDir();
  const service = new AgentService({
    config,
    provider,
    dataDir,
    redactor: new Redactor({ values: [SECRET] }),
    identity: { name: "bashy", isNew: false, source: "chosen" },
  });

  const events: string[] = [];
  const result = await service.handle(
    { id: "e1", trigger: "cli", input: "print the token", conversationKey: "c1" },
    { onEvent: (e) => events.push(JSON.stringify(e)) },
  );

  // The tool result the model read.
  const toolMessage = result.messages.find((m) => m.role === "tool")!;
  assert(!toolMessage.content.includes(SECRET), `transcript leaked: ${toolMessage.content}`);
  assertStringIncludes(toolMessage.content, REDACTED);
  // The reply that goes to chat and into the runs table.
  assert(!result.reply.includes(SECRET), `reply leaked: ${result.reply}`);
  // The event stream a REPL or trace exporter consumes.
  assertEquals(events.filter((e) => e.includes(SECRET)), []);
  service.store.close();

  // And the database on disk.
  const bytes = await Deno.readFile(`${dataDir}/bash-bot.db`);
  assert(!new TextDecoder().decode(bytes).includes(SECRET), "secret is on disk");
});

Deno.test("redaction: an http body echoing the secret comes back scrubbed", async () => {
  const engine = new PermissionEngine({ net: ["api.example.com"] });
  const redactor = new Redactor({ values: [SECRET] });
  const tool = createHttpRequestTool({
    permissions: engine,
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: `invalid key ${SECRET}` }), {
          headers: { "content-type": "application/json" },
        }),
      ),
  });

  const raw = await tool.execute(JSON.stringify({ url: "https://api.example.com/v1/charges" }));
  const result = redactor.jsonText(raw);

  assert(!result.includes(SECRET), `secret survived: ${result}`);
  assertStringIncludes(result, REDACTED);
});

Deno.test("http credentials: the runtime attaches the header, the model never sees it", async () => {
  let sent: Headers | undefined;
  const tool = createHttpRequestTool({
    permissions: new PermissionEngine({ net: ["api.example.com"] }),
    credentials: [
      { url: "https://api.example.com", header: "Authorization", value: `Bearer ${SECRET}` },
    ],
    fetch: (_url, init) => {
      sent = new Headers(init?.headers);
      return Promise.resolve(new Response("{}"));
    },
  });

  // The model asks for the URL and supplies a placeholder it invented; the
  // real credential is attached after the call and overrides it.
  await tool.execute(JSON.stringify({
    url: "https://api.example.com/v1/charges",
    headers: { Authorization: "Bearer <your-key-here>" },
  }));

  assertEquals(sent?.get("authorization"), `Bearer ${SECRET}`);
  // The tool never advertises the value, only the URLs it covers.
  assertStringIncludes(tool.def.description, "https://api.example.com");
  assert(!tool.def.description.includes(SECRET));
});

Deno.test("http credentials: an unmatched URL gets nothing attached", async () => {
  let sent: Headers | undefined;
  const tool = createHttpRequestTool({
    permissions: new PermissionEngine({ net: ["*"] }),
    credentials: [{ url: "https://api.example.com", header: "Authorization", value: "Bearer x" }],
    fetch: (_url, init) => {
      sent = new Headers(init?.headers);
      return Promise.resolve(new Response("{}"));
    },
  });

  await tool.execute(JSON.stringify({ url: "https://elsewhere.example.org/" }));

  assertEquals(sent?.get("authorization"), null);
});

Deno.test("redaction: an MCP server echoing the secret comes back scrubbed", async () => {
  const server = new McpServer({ name: "leaky", version: "0.0.0" });
  server.registerTool("whoami", {
    description: "Echoes its own credentials, as servers do in error messages",
    inputSchema: { probe: z.string() },
  }, () => ({ content: [{ type: "text" as const, text: `authenticated with ${SECRET}` }] }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);

  const redactor = new Redactor({ values: [SECRET] });
  const tools = await mcpToolsFromClient(client, "leaky");
  const raw = await tools[0].execute(JSON.stringify({ probe: "x" }));
  const result = redactor.jsonText(raw);

  assert(!result.includes(SECRET), `secret survived: ${result}`);
  assertEquals(result, `authenticated with ${REDACTED}`);
  await client.close();
});

Deno.test("redaction: nothing a run persisted holds the secret", async () => {
  const path = `${await Deno.makeTempDir()}/store.db`;
  const store = new Store(path, { redactor: new Redactor({ values: [SECRET] }) });

  store.saveMessages(store.sessionFor("c1"), [
    { role: "user", content: "check the key" },
    { role: "tool", toolCallId: "t1", content: `exported ${SECRET}` },
  ]);
  const runId = store.recordRun({
    trigger: "cli",
    input: `use ${SECRET}`,
    status: "ok",
    reply: `I used ${SECRET}`,
    steps: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    startedAt: new Date().toISOString(),
  });
  store.recordAudit({
    runId,
    kind: "mcp",
    detail: { tool: "whoami", ok: false, error: `bad token ${SECRET}` },
  });
  store.close();

  // Read the file back as bytes: whatever shape the rows have, the value is
  // not in them.
  const bytes = await Deno.readFile(path);
  assert(!new TextDecoder().decode(bytes).includes(SECRET), "secret is on disk");
});

Deno.test("redaction: the loop scrubs tool results, events, and the provider's error body", async () => {
  const config = parseAgentConfig(`
handle: loop-bot
description: loop redaction
model:
  provider: openai-compatible
  id: test-model
purpose: You do a job.
`);
  const redact = (text: string) => new Redactor({ values: [SECRET] }).text(text);
  const leakyTool = {
    def: { name: "leak", description: "leaks", inputSchema: {} },
    execute: () => Promise.resolve(`here it is: ${SECRET}`),
  };

  // One tool call, then the provider fails with an error body quoting the key.
  let call = 0;
  const provider: Provider = {
    id: "stub",
    complete: (_req: CompletionRequest): Promise<Completion> => {
      if (call++ === 0) {
        return Promise.resolve({
          content: "",
          toolCalls: [{ id: "1", name: "leak", arguments: `{"key":"${SECRET}"}` }],
          stopReason: "tool_calls",
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      }
      return Promise.reject(
        new ProviderError(`provider returned 401: {"key":"${SECRET}"}`, "auth", 401),
      );
    },
  };

  const events: string[] = [];
  const result = await runAgent({
    config,
    provider,
    tools: [leakyTool],
    input: "go",
    redact,
    onEvent: (e) => events.push(JSON.stringify(e)),
  });

  assertEquals(result.status, "error_provider");
  // The reply becomes the run record and the chat message.
  assert(!result.reply.includes(SECRET), `reply leaked: ${result.reply}`);
  // The tool result is the model's next message.
  const toolMessage = result.messages.find((m) => m.role === "tool")!;
  assertEquals(toolMessage.content, `here it is: ${REDACTED}`);
  // The event stream is what a trace exporter and the REPL consume.
  const leaked = events.filter((e) => e.includes(SECRET));
  assertEquals(leaked, [], `events leaked: ${leaked.join("\n")}`);
});
