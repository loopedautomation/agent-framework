import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parseAgentConfig } from "../config/load.ts";
import type { Completion, CompletionRequest, Provider } from "../providers/types.ts";
import { AgentService } from "./service.ts";

const CONFIG = parseAgentConfig(`
handle: cmd-bot
description: slash command test
model:
  provider: openai-compatible
  id: test-model
purpose: test
memory:
  scope: thread
commands:
  - name: standup
    description: Summarize the last day of activity
    prompt: |
      Summarize the last 24 hours. Focus: $ARGS
`);

/** A provider that records inputs; built-in commands must never reach it. */
function recordingProvider(): { provider: Provider; inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    provider: {
      id: "mock",
      complete(req: CompletionRequest): Promise<Completion> {
        const last = req.messages.at(-1);
        if (typeof last?.content === "string") inputs.push(last.content);
        return Promise.resolve({
          content: "Nova",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    },
  };
}

Deno.test("built-in commands run without a provider call", async () => {
  const dataDir = await Deno.makeTempDir();
  const { provider, inputs } = recordingProvider();
  const service = new AgentService({ config: CONFIG, provider, dataDir });
  await service.init(); // naming ritual is the only provider call allowed
  const ritualCalls = inputs.length;

  const help = await service.handle({ id: "e1", trigger: "cli", input: "/help" });
  assertEquals(help.steps, 0);
  assertEquals(help.usage, { inputTokens: 0, outputTokens: 0 });
  assertStringIncludes(help.reply, "/help");
  assertStringIncludes(help.reply, "/standup — Summarize the last day of activity");

  const status = await service.handle({ id: "e2", trigger: "cli", input: "/status" });
  assertStringIncludes(status.reply, "cmd-bot");
  assertStringIncludes(status.reply, "openai-compatible/test-model");
  assertStringIncludes(status.reply, "uptime:");

  assertEquals(inputs.length, ritualCalls); // no run reached the model

  // Every command execution lands in the audit trail with its own kind.
  const audit = service.store.recentAudit();
  const kinds = audit.filter((a) => a.kind === "command");
  assertEquals(kinds.length, 2);

  await service.stop();
});

Deno.test("/reset clears only the thread it was typed in", async () => {
  const dataDir = await Deno.makeTempDir();
  const { provider } = recordingProvider();
  const service = new AgentService({ config: CONFIG, provider, dataDir });

  await service.handle({ id: "e1", trigger: "cli", input: "hi", conversationKey: "discord:a" });
  await service.handle({ id: "e2", trigger: "cli", input: "hi", conversationKey: "discord:b" });

  const reset = await service.handle({
    id: "e3",
    trigger: "cli",
    input: "/reset",
    conversationKey: "discord:a",
  });
  assertStringIncludes(reset.reply, "cleared");

  assertEquals(service.store.loadMessages(service.store.sessionFor("discord:a")), []);
  assert(service.store.loadMessages(service.store.sessionFor("discord:b")).length > 0);

  await service.stop();
});

Deno.test("/reset without a conversation says there is nothing to reset", async () => {
  const dataDir = await Deno.makeTempDir();
  const { provider } = recordingProvider();
  const service = new AgentService({ config: CONFIG, provider, dataDir });
  const result = await service.handle({ id: "e1", trigger: "cli", input: "/reset" });
  assertStringIncludes(result.reply, "no");
  await service.stop();
});

Deno.test("/new archives the thread and the conversation restarts clean", async () => {
  const dataDir = await Deno.makeTempDir();
  const { provider, inputs } = recordingProvider();
  const service = new AgentService({ config: CONFIG, provider, dataDir });

  await service.handle({ id: "e1", trigger: "cli", input: "hi", conversationKey: "discord:a" });
  const oldSession = service.store.sessionFor("discord:a");

  const fresh = await service.handle({
    id: "e2",
    trigger: "cli",
    input: "/new",
    conversationKey: "discord:a",
  });
  assertStringIncludes(fresh.reply, "Fresh conversation started");

  // The next run starts with no history, while the old transcript survives
  // under the archived session id.
  const before = inputs.length;
  await service.handle({ id: "e3", trigger: "cli", input: "again", conversationKey: "discord:a" });
  assertEquals(inputs.length, before + 1);
  const newSession = service.store.sessionFor("discord:a");
  assert(newSession !== oldSession);
  assertEquals(service.store.loadMessages(newSession).length, 2); // just the new exchange
  assertEquals(service.store.loadMessages(oldSession).length, 2); // untouched

  await service.stop();
});

Deno.test("/new twice in a row admits there is nothing to archive", async () => {
  const dataDir = await Deno.makeTempDir();
  const { provider } = recordingProvider();
  const service = new AgentService({ config: CONFIG, provider, dataDir });

  await service.handle({ id: "e1", trigger: "cli", input: "hi", conversationKey: "k" });
  await service.handle({ id: "e2", trigger: "cli", input: "/new", conversationKey: "k" });
  const again = await service.handle({
    id: "e3",
    trigger: "cli",
    input: "/new",
    conversationKey: "k",
  });
  assertStringIncludes(again.reply, "Already a fresh conversation");

  const sessionless = await service.handle({ id: "e4", trigger: "cli", input: "/new" });
  assertStringIncludes(sessionless.reply, "Nothing to start over");

  await service.stop();
});

Deno.test("config-defined command substitutes $ARGS and runs the loop", async () => {
  const dataDir = await Deno.makeTempDir();
  const { provider, inputs } = recordingProvider();
  const service = new AgentService({ config: CONFIG, provider, dataDir });

  const result = await service.handle({ id: "e1", trigger: "cli", input: "/standup deploys" });
  assertEquals(result.status, "ok");
  assertStringIncludes(inputs.at(-1) ?? "", "Focus: deploys");

  const audit = service.store.recentAudit();
  const cmd = audit.find((a) => a.kind === "command");
  assert(cmd);
  const detail = JSON.parse(cmd.detail_json as string);
  assertEquals(detail, { name: "standup", args: "deploys", builtin: false });

  await service.stop();
});

Deno.test("unknown slash text falls through to the model", async () => {
  const dataDir = await Deno.makeTempDir();
  const { provider, inputs } = recordingProvider();
  const service = new AgentService({ config: CONFIG, provider, dataDir });
  await service.init();
  const before = inputs.length;
  await service.handle({ id: "e1", trigger: "cli", input: "/shrug" });
  assertEquals(inputs.length, before + 1);
  assertEquals(inputs.at(-1), "/shrug");
  await service.stop();
});

Deno.test("/stop aborts the in-flight run in its conversation", async () => {
  const dataDir = await Deno.makeTempDir();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const provider: Provider = {
    id: "mock",
    async complete(): Promise<Completion> {
      calls++;
      await gate;
      return {
        content: "",
        toolCalls: [{ id: "t1", name: "nonexistent", arguments: "{}" }],
        stopReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const service = new AgentService({
    config: CONFIG,
    provider,
    dataDir,
    identity: { name: "Nova", isNew: false, source: "chosen" },
  });

  const running = service.handle({
    id: "e1",
    trigger: "cli",
    input: "count to a million",
    conversationKey: "k",
  });
  // Wait until the run holds its provider call, then stop it from outside.
  while (calls === 0) await new Promise((r) => setTimeout(r, 5));
  const stop = await service.handle({
    id: "e2",
    trigger: "cli",
    input: "/stop",
    conversationKey: "k",
  });
  assertStringIncludes(stop.reply, "Stopping");
  release();

  const result = await running;
  assertEquals(result.status, "aborted");
  assertEquals(calls, 1); // the loop made no further provider calls

  const audit = service.store.recentAudit();
  const cmd = audit.find((a) => a.kind === "command");
  assert(cmd);
  const detail = JSON.parse(cmd.detail_json as string);
  assertEquals(detail, { name: "stop", args: "", builtin: true, stopped: true });

  await service.stop();
});

Deno.test("/stop with nothing running says so", async () => {
  const dataDir = await Deno.makeTempDir();
  const { provider } = recordingProvider();
  const service = new AgentService({
    config: CONFIG,
    provider,
    dataDir,
    identity: { name: "Nova", isNew: false, source: "chosen" },
  });
  const result = await service.handle({
    id: "e1",
    trigger: "cli",
    input: "/stop",
    conversationKey: "k",
  });
  assertEquals(result.status, "ok");
  assertStringIncludes(result.reply, "Nothing is running");
  await service.stop();
});
