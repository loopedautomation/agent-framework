import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { agentConfigJsonSchema } from "./schema.ts";
import { collectEnvRefs, ConfigError, parseAgentConfig, resolveAgentConfig } from "./load.ts";

const MINIMAL = `
handle: test-bot
description: A minimal test agent.
model:
  provider: openai-compatible
  id: gpt-5.4-mini
purpose: You are a test agent.
`;

Deno.test("parses a minimal config and applies defaults", () => {
  const config = parseAgentConfig(MINIMAL);
  assertEquals(config.handle, "test-bot");
  assertEquals(config.model.provider, "openai-compatible");
  assertEquals(config.limits.max_steps, 20);
  assertEquals(config.permissions, undefined); // deny-by-default: nothing granted
});

Deno.test("parses the full MVP-shaped config", () => {
  const config = parseAgentConfig(`
handle: issue-bot
description: Turns team Discord messages into GitHub issues.
model:
  provider: openai-compatible
  id: gpt-5.4-mini
  small: gpt-5.4-mini
  api_key_env: OPENAI_API_KEY
  pricing:
    input_per_mtok: 0.15
    output_per_mtok: 0.60
purpose: You manage GitHub issues for the team.
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
handle: env-bot
description: env test
model:
  provider: anthropic
  id: claude-sonnet-5
  api_key_env: ANTHROPIC_API_KEY
purpose: test
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
  assertEquals(config.handle, "issue-bot");
  assertEquals(collectEnvRefs(config), ["GITHUB_TOKEN", "OPENAI_API_KEY"]);
});

Deno.test("emits a JSON schema with the top-level fields", () => {
  const schema = agentConfigJsonSchema();
  const props = schema.properties as Record<string, unknown>;
  for (const key of ["handle", "model", "purpose", "permissions", "limits"]) {
    assert(key in props, `missing ${key} in JSON schema`);
  }
});

Deno.test("system_prompt gets a rename hint, not a generic unknown-key error", () => {
  const err = assertThrows(
    () =>
      parseAgentConfig(
        `handle: old\ndescription: d\nmodel:\n  provider: anthropic\n  id: m\nsystem_prompt: legacy`,
      ),
    ConfigError,
  );
  assert(err.message.includes("renamed to `purpose`"));
});

Deno.test("resolveAgentConfig: env var, file, both, neither", async () => {
  const dir = await Deno.makeTempDir();
  const filePath = `${dir}/agent.yaml`;

  // env var only → parsed from env
  const fromEnv = await resolveAgentConfig(
    filePath,
    (n) => n === "LOOPED_AGENT_CONFIG" ? MINIMAL : undefined,
  );
  assertEquals(fromEnv.handle, "test-bot");

  // file only → parsed from file
  await Deno.writeTextFile(filePath, MINIMAL.replace("test-bot", "file-bot"));
  const fromFile = await resolveAgentConfig(filePath, () => undefined);
  assertEquals(fromFile.handle, "file-bot");

  // both → loud conflict, never a guess
  await assertRejects(
    () => resolveAgentConfig(filePath, (n) => (n === "LOOPED_AGENT_CONFIG" ? MINIMAL : undefined)),
    ConfigError,
    "remove one",
  );

  // neither → readable missing-file error
  await assertRejects(
    () => resolveAgentConfig(`${dir}/missing.yaml`, () => undefined),
    ConfigError,
    "cannot read",
  );
});

Deno.test("tools.custom is rejected loudly until implemented", () => {
  const err = assertThrows(
    () => parseAgentConfig(MINIMAL + `tools:\n  custom: [./my-tool.ts]\n`),
    ConfigError,
  );
  assert(err.message.includes("not implemented"));
});

Deno.test("the shipped agent-builder example is a valid agent definition", async () => {
  const path = new URL("../../../examples/agent-builder/agent.yaml", import.meta.url);
  const config = parseAgentConfig(await Deno.readTextFile(path), "examples/agent-builder");
  assertEquals(config.handle, "agent-builder");
  assertEquals(config.permissions?.write, ["agents"]);
});
