import { assert, assertEquals, assertThrows } from "@std/assert";
import { agentConfigJsonSchema } from "./schema.ts";
import { collectEnvRefs, ConfigError, parseAgentConfig } from "./load.ts";

const MINIMAL = `
nickname: test-bot
description: A minimal test agent.
model:
  provider: openai-compatible
  id: gpt-5.4-mini
system_prompt: You are a test agent.
`;

Deno.test("parses a minimal config and applies defaults", () => {
  const config = parseAgentConfig(MINIMAL);
  assertEquals(config.nickname, "test-bot");
  assertEquals(config.model.provider, "openai-compatible");
  assertEquals(config.limits.max_steps, 20);
  assertEquals(config.permissions, undefined); // deny-by-default: nothing granted
});

Deno.test("parses the full MVP-shaped config", () => {
  const config = parseAgentConfig(`
nickname: issue-bot
description: Turns team Discord messages into GitHub issues.
model:
  provider: openai-compatible
  id: gpt-5.4-mini
  small: gpt-5.4-mini
  api_key_env: OPENAI_API_KEY
  pricing:
    input_per_mtok: 0.15
    output_per_mtok: 0.60
system_prompt: You manage GitHub issues for the team.
triggers:
  - type: discord
    channels: ["issues"]
  - type: cron
    schedule: "0 9 * * 1"
    prompt: Post a summary of open issues.
skills:
  - ./skills/gh-issues.md
tools:
  mcp:
    - name: github
      command: ["docker", "run", "-i", "ghcr.io/github/github-mcp-server"]
      env:
        GITHUB_TOKEN: \${GITHUB_TOKEN}
      include: [create_issue, update_issue]
permissions:
  net: [discord.com, gateway.discord.gg, api.github.com]
  run: [gh]
env:
  GITHUB_TOKEN: \${GITHUB_TOKEN}
memory:
  scope: thread
limits:
  max_steps: 10
  max_cost: 0.10
`);
  assertEquals(config.triggers?.length, 2);
  assertEquals(config.memory?.scope, "thread");
  assertEquals(config.limits.max_cost, 0.10);
});

Deno.test("rejects unknown keys loudly (typos must not silently no-op)", () => {
  const err = assertThrows(
    () => parseAgentConfig(MINIMAL + `permisions:\n  net: [example.com]\n`),
    ConfigError,
  );
  assert(err.message.includes("permisions"));
});

Deno.test("rejects an unknown trigger type", () => {
  assertThrows(
    () => parseAgentConfig(MINIMAL + `triggers:\n  - type: slack\n`),
    ConfigError,
  );
});

Deno.test("rejects a user-chosen name field (agents name themselves)", () => {
  assertThrows(
    () => parseAgentConfig(MINIMAL + `name: my-agent\n`),
    ConfigError,
  );
});

Deno.test("rejects an MCP server with both command and url", () => {
  assertThrows(
    () =>
      parseAgentConfig(
        MINIMAL +
          `tools:\n  mcp:\n    - name: gh\n      command: [gh-mcp]\n      url: https://example.com/mcp\n`,
      ),
    ConfigError,
  );
});

Deno.test("rejects invalid YAML with a readable error", () => {
  const err = assertThrows(() => parseAgentConfig(":\n  - not yaml", "agent.yaml"), ConfigError);
  assert(err.message.includes("agent.yaml"));
});

Deno.test("collects env references from api_key_env, env, and mcp env", () => {
  const config = parseAgentConfig(`
nickname: env-bot
description: env test
model:
  provider: anthropic
  id: claude-sonnet-5
  api_key_env: ANTHROPIC_API_KEY
system_prompt: test
tools:
  mcp:
    - name: github
      url: https://example.com/mcp
      env:
        GITHUB_TOKEN: \${GITHUB_TOKEN}
env:
  WEBHOOK_SECRET: \${WEBHOOK_SECRET}
  NOT_A_REF: literal-value
`);
  assertEquals(collectEnvRefs(config), [
    "ANTHROPIC_API_KEY",
    "GITHUB_TOKEN",
    "WEBHOOK_SECRET",
  ]);
});

Deno.test("the shipped issue-bot example is a valid agent definition", async () => {
  const path = new URL("../../../examples/issue-bot/agent.yaml", import.meta.url);
  const config = parseAgentConfig(await Deno.readTextFile(path), "examples/issue-bot/agent.yaml");
  assertEquals(config.nickname, "issue-bot");
  assertEquals(collectEnvRefs(config), ["GITHUB_TOKEN", "OPENAI_API_KEY"]);
});

Deno.test("emits a JSON schema with the top-level fields", () => {
  const schema = agentConfigJsonSchema();
  const props = schema.properties as Record<string, unknown>;
  for (const key of ["nickname", "model", "system_prompt", "permissions", "limits"]) {
    assert(key in props, `missing ${key} in JSON schema`);
  }
});
