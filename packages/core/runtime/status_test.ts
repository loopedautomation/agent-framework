import { assert, assertEquals } from "@std/assert";
import { parseAgentConfig } from "../config/load.ts";
import type { Completion, Provider } from "../providers/types.ts";
import { AgentService } from "./service.ts";
import { startStatusServer } from "./status.ts";

const CONFIG = parseAgentConfig(`
nickname: status-bot
description: status test
model:
  provider: openai-compatible
  id: test-model
system_prompt: test
`);

const provider: Provider = {
  id: "mock",
  complete(): Promise<Completion> {
    return Promise.resolve({
      content: "Nova",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  },
};

Deno.test("status surface: healthz open, runs/audit token-gated", async () => {
  const dataDir = await Deno.makeTempDir();
  const service = new AgentService({ config: CONFIG, provider, dataDir });
  await service.init(); // naming ritual → "Nova"
  await service.handle({ id: "e1", trigger: "cli", input: "hi" });

  let port = 0;
  const server = startStatusServer(service, {
    port: 0,
    token: "st4tus",
    onListen: (addr) => (port = addr.port),
  });
  const base = `http://127.0.0.1:${port}`;

  const health = await (await fetch(`${base}/healthz`)).json();
  assertEquals(health.ok, true);
  assertEquals(health.nickname, "status-bot");
  assertEquals(health.name, "Nova");

  const unauthorized = await fetch(`${base}/runs`);
  assertEquals(unauthorized.status, 401);
  await unauthorized.body?.cancel();

  const runs = await (await fetch(`${base}/runs`, {
    headers: { authorization: "Bearer st4tus" },
  })).json();
  assertEquals(runs.runs.length, 1);
  assertEquals(runs.runs[0].trigger, "cli");

  const audit = await fetch(`${base}/audit`, { headers: { authorization: "Bearer st4tus" } });
  assertEquals(audit.status, 200);
  await audit.body?.cancel();

  await server.shutdown();
  await service.stop();
});

Deno.test("status surface: without a token, loopback callers are allowed", async () => {
  const dataDir = await Deno.makeTempDir();
  const service = new AgentService({ config: CONFIG, provider, dataDir });
  let port = 0;
  const server = startStatusServer(service, { port: 0, onListen: (addr) => (port = addr.port) });

  const runs = await fetch(`http://127.0.0.1:${port}/runs`);
  assertEquals(runs.status, 200); // we ARE a loopback caller
  await runs.body?.cancel();
  assert((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).ok);

  await server.shutdown();
  await service.stop();
});
