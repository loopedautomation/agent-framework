import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { agentConfigJsonSchema } from "./schema.ts";
import { FLOOR_ENV } from "../permissions/floor.ts";
import {
  collectEnvRefs,
  ConfigError,
  loadAgentConfig,
  parseAgentConfig,
  requiredEnvRefs,
  resolveAgentConfig,
} from "./load.ts";
import { expandConfigHosts } from "./env.ts";
import { hermeticPlan, IMAGE_ENV } from "../permissions/hermetic.ts";

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
  assertEquals(config.limits.concurrent_runs, 4);
  assertEquals(config.limits.queue_depth, 10);
  assertEquals(config.permissions, undefined); // deny-by-default: nothing granted
});

Deno.test("name: optional, parsed when set, bounds enforced", () => {
  assertEquals(parseAgentConfig(MINIMAL).name, undefined);
  assertEquals(parseAgentConfig(MINIMAL + "name: Marlow\n").name, "Marlow");
  assertThrows(() => parseAgentConfig(MINIMAL + "name: X\n"), ConfigError); // too short
  assertThrows(() => parseAgentConfig(MINIMAL + `name: ${"x".repeat(41)}\n`), ConfigError); // too long
});

Deno.test("limits: concurrency fields parse, keep sibling defaults, and reject zero runs", () => {
  const config = parseAgentConfig(MINIMAL + "limits:\n  concurrent_runs: 1\n  queue_depth: 0\n");
  assertEquals(config.limits.concurrent_runs, 1); // whole-agent serialization
  assertEquals(config.limits.queue_depth, 0); // refuse anything while busy
  assertEquals(config.limits.max_steps, 20);
  assertThrows(
    () => parseAgentConfig(MINIMAL + "limits:\n  concurrent_runs: 0\n"),
    ConfigError,
  );
});

Deno.test("memory: compact_at_tokens defaults on, takes a value, and false disables", () => {
  assertEquals(parseAgentConfig(MINIMAL).memory, undefined); // no memory block, no field
  const defaulted = parseAgentConfig(MINIMAL + "memory:\n  scope: thread\n");
  assertEquals(defaulted.memory?.compact_at_tokens, 50_000);
  const tuned = parseAgentConfig(MINIMAL + "memory:\n  scope: thread\n  compact_at_tokens: 8000\n");
  assertEquals(tuned.memory?.compact_at_tokens, 8_000);
  const off = parseAgentConfig(MINIMAL + "memory:\n  scope: thread\n  compact_at_tokens: false\n");
  assertEquals(off.memory?.compact_at_tokens, false);
  assertThrows(
    () => parseAgentConfig(MINIMAL + "memory:\n  scope: thread\n  compact_at_tokens: 0\n"),
    ConfigError,
  );
});

Deno.test("schedules: block presence enables, max defaults and validates", () => {
  assertEquals(parseAgentConfig(MINIMAL).schedules, undefined);
  assertEquals(parseAgentConfig(MINIMAL + "schedules: {}\n").schedules, { max: 20 });
  assertEquals(parseAgentConfig(MINIMAL + "schedules:\n  max: 3\n").schedules, { max: 3 });
  assertThrows(() => parseAgentConfig(MINIMAL + "schedules:\n  max: 0\n"), ConfigError);
});

Deno.test("config commands cannot shadow the compaction built-ins", () => {
  for (const name of ["compact", "new"]) {
    assertThrows(
      () =>
        parseAgentConfig(
          MINIMAL + `commands:\n  - name: ${name}\n    description: shadowing\n    prompt: hi\n`,
        ),
      ConfigError,
      "built-in",
    );
  }
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
`);
  assertEquals(config.triggers?.length, 2);
  assertEquals(config.memory?.scope, "thread");
  assertEquals(config.limits.max_steps, 10);
});

Deno.test("accepts an uppercase handle", () => {
  const config = parseAgentConfig(`
handle: LoopedAgent
description: A minimal test agent.
model:
  provider: openai-compatible
  id: gpt-5.4-mini
purpose: You are a test agent.
`);
  assertEquals(config.handle, "LoopedAgent");
});

Deno.test("rejects a handle with invalid characters", () => {
  const err = assertThrows(
    () => parseAgentConfig(MINIMAL.replace("handle: test-bot", "handle: test_bot")),
    ConfigError,
  );
  assert(err.message.includes("handle"));
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
    () => parseAgentConfig(MINIMAL + `triggers:\n  - type: teams\n`),
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

Deno.test("collectEnvRefs includes the provider's default key env when api_key_env is omitted", () => {
  // MINIMAL names no api_key_env, so the openai-compatible default applies.
  assertEquals(collectEnvRefs(parseAgentConfig(MINIMAL)), ["OPENAI_API_KEY"]);

  const claude = parseAgentConfig(`
handle: claude-bot
description: anthropic default key env
model:
  provider: anthropic
  id: claude-sonnet-5
purpose: test
`);
  assertEquals(collectEnvRefs(claude), ["ANTHROPIC_API_KEY"]);
});

Deno.test("collectEnvRefs picks up the voice engines' keys, defaults included", () => {
  const voice = parseAgentConfig(`
handle: voice-bot
description: voice keys
model:
  provider: anthropic
  id: claude-sonnet-5
purpose: test
voice:
  stt:
    provider: openai
  tts:
    provider: elevenlabs
  live:
    provider: openai
    api_key_env: LIVE_KEY
`);
  // A key the redactor never learns about is a key it cannot scrub, so the
  // defaults have to resolve here and not just at the engine.
  assertEquals(collectEnvRefs(voice), [
    "ANTHROPIC_API_KEY",
    "ELEVENLABS_API_KEY",
    "LIVE_KEY",
    "OPENAI_API_KEY",
  ]);
});

Deno.test("collectEnvRefs skips the key env for keyless base_url endpoints", () => {
  const local = parseAgentConfig(`
handle: local-bot
description: local model, no key needed
model:
  provider: openai-compatible
  id: llama3.1
  base_url: http://localhost:11434/v1
purpose: test
`);
  assertEquals(collectEnvRefs(local), []);

  // An explicit api_key_env still counts, base_url or not (e.g. OpenRouter).
  const openrouter = parseAgentConfig(`
handle: router-bot
description: keyed base_url endpoint
model:
  provider: openai-compatible
  id: gpt-5.4-mini
  base_url: https://openrouter.ai/api/v1
  api_key_env: OPENROUTER_API_KEY
purpose: test
`);
  assertEquals(collectEnvRefs(openrouter), ["OPENROUTER_API_KEY"]);
});

Deno.test("the shipped gh-issues-bot example is a valid agent definition", async () => {
  const path = new URL("../../../examples/gh-issues-bot/agent.yaml", import.meta.url);
  const config = parseAgentConfig(
    await Deno.readTextFile(path),
    "examples/gh-issues-bot/agent.yaml",
  );
  assertEquals(config.handle, "gh-issues-bot");
  assertEquals(collectEnvRefs(config), ["GITHUB_TOKEN", "OPENAI_API_KEY"]);
});

Deno.test("the shipped interpreter-bot example is a valid agent definition", async () => {
  const path = new URL("../../../examples/interpreter-bot/agent.yaml", import.meta.url);
  const config = parseAgentConfig(
    await Deno.readTextFile(path),
    "examples/interpreter-bot/agent.yaml",
  );
  assertEquals(config.handle, "interpreter-bot");
  // Both engines' keys, the stt default included — a key the redactor never
  // learns about is a key it cannot scrub.
  assertEquals(collectEnvRefs(config), ["ELEVENLABS_API_KEY", "OPENAI_API_KEY"]);
  // The example's whole claim: the voice block is the capability, and there
  // is nothing else. A permissions block here would make the README a lie.
  assertEquals(config.permissions, undefined);
  assertEquals(config.tools, undefined);
  assertEquals(config.voice?.tts?.provider, "elevenlabs");
});

Deno.test("the shipped standup-bot example is a valid agent definition", async () => {
  const path = new URL("../../../examples/standup-bot/agent.yaml", import.meta.url);
  const config = parseAgentConfig(
    await Deno.readTextFile(path),
    "examples/standup-bot/agent.yaml",
  );
  assertEquals(config.handle, "standup-bot");
  // One key covers the model, the transcription, the speech and the realtime
  // session — and the example would be a lie if the voice block asked for more.
  assertEquals(collectEnvRefs(config), ["OPENAI_API_KEY"]);
  // Live voice is the point of this example; a discord trigger with no voice
  // channel to join would leave it demonstrating nothing.
  assertEquals(config.voice?.live?.provider, "openai");
  const discord = config.triggers?.[0];
  assert(discord?.type === "discord" && discord.voice_channels?.length);
});

Deno.test("the shipped github-bot example is a valid, hermetic agent definition", async () => {
  const path = new URL("../../../examples/github-bot/agent.yaml", import.meta.url);
  const config = parseAgentConfig(
    await Deno.readTextFile(path),
    "examples/github-bot/agent.yaml",
  );
  assertEquals(config.handle, "github-bot");
  assertEquals(requiredEnvRefs(config), [
    "ANTHROPIC_API_KEY",
    "GITHUB_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "TTY_TOKEN",
  ]);
  // The README's claim: one exactly-matched host and nothing else. A `run:`
  // grant or a wildcard here would cost hermetic mode and make it a lie —
  // the CLI variant (agent.cli.yaml) is where that trade is made on purpose.
  assertEquals(config.permissions?.net, ["api.github.com"]);
  assertEquals(config.permissions?.run, undefined);
  assert(hermeticPlan(config, IMAGE_ENV).eligible);
});

Deno.test("the shipped coolify-bot example is a valid, hermetic agent definition", async () => {
  const path = new URL("../../../examples/coolify-bot/agent.yaml", import.meta.url);
  const config = parseAgentConfig(
    await Deno.readTextFile(path),
    "examples/coolify-bot/agent.yaml",
  );
  assertEquals(config.handle, "coolify-bot");
  assertEquals(requiredEnvRefs(config), [
    "ANTHROPIC_API_KEY",
    "COOLIFY_API_TOKEN",
    "COOLIFY_HOST",
    "TELEGRAM_BOT_TOKEN",
    "TTY_TOKEN",
  ]);
  // The host is deployment configuration, not something to commit — the
  // committed file carries the reference and nothing else.
  assertEquals(config.permissions?.net, ["${COOLIFY_HOST}"]);
  assertEquals(config.http?.auth?.[0].url, "https://${COOLIFY_HOST}");
  assertEquals(config.permissions?.run, undefined);
  // The token is attached server side, so the model never sees it — the
  // whole reason the example can hand a deploy button to a chat trigger.
  assertEquals(config.http?.auth?.length, 1);
  // Hermetic eligibility is decided on the expanded config: the host that
  // reaches --allow-net has to be the real one, not the reference.
  const getEnv = (name: string) => name === "COOLIFY_HOST" ? "coolify.looped.sh" : undefined;
  const expanded = expandConfigHosts(config, { getEnv, secretsDir: "/nonexistent" });
  const plan = hermeticPlan(expanded, IMAGE_ENV);
  assert(plan.eligible);
  assert(plan.hosts.includes("coolify.looped.sh"));
  assert(plan.flags.some((f) => f.includes("coolify.looped.sh")));
});

Deno.test("expandConfigHosts resolves permissions.net and http.auth urls", () => {
  const config = parseAgentConfig(`
handle: host-bot
description: env-referenced host
model:
  provider: anthropic
  id: claude-sonnet-5
purpose: You operate the instance at https://\${APP_HOST}.
permissions:
  net: ["\${APP_HOST}", api.github.com]
http:
  auth:
    - url: https://\${APP_HOST}/api/v1
      value: Bearer \${APP_TOKEN}
`);
  const opts = {
    getEnv: (n: string) => n === "APP_HOST" ? "coolify.looped.sh" : undefined,
    secretsDir: "/nonexistent",
  };
  const expanded = expandConfigHosts(config, opts);
  assertEquals(expanded.permissions?.net, ["coolify.looped.sh", "api.github.com"]);
  assertEquals(expanded.http?.auth?.[0].url, "https://coolify.looped.sh/api/v1");
  // The credential is the service's business, not this function's — expanding
  // it here would put a secret in the config object the sandbox is built from.
  assertEquals(expanded.http?.auth?.[0].value, "Bearer ${APP_TOKEN}");
  // The reference has to be reported, or `af validate` would call a config
  // complete that cannot start.
  assert(requiredEnvRefs(config).includes("APP_HOST"));

  // Missing: a running path fails at startup, a describing path keeps the
  // reference visible instead.
  const none = { getEnv: () => undefined, secretsDir: "/nonexistent" };
  assertThrows(() => expandConfigHosts(config, none), ConfigError, "APP_HOST");
  assertEquals(
    expandConfigHosts(config, { ...none, lenient: true }).permissions?.net,
    ["${APP_HOST}", "api.github.com"],
  );
});

Deno.test("expandConfigHosts returns the config untouched when nothing references anything", () => {
  const config = parseAgentConfig(MINIMAL + `permissions:\n  net: [api.github.com]\n`);
  assertEquals(expandConfigHosts(config), config);
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
    (n) => n === "AF_AGENT_CONFIG" ? MINIMAL : undefined,
  );
  assertEquals(fromEnv.handle, "test-bot");

  // file only → parsed from file
  await Deno.writeTextFile(filePath, MINIMAL.replace("test-bot", "file-bot"));
  const fromFile = await resolveAgentConfig(filePath, () => undefined);
  assertEquals(fromFile.handle, "file-bot");

  // both → loud conflict, never a guess
  await assertRejects(
    () => resolveAgentConfig(filePath, (n) => (n === "AF_AGENT_CONFIG" ? MINIMAL : undefined)),
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

Deno.test("LOOPED_AGENT_CONFIG gets a rename hint, not a missing-file error", async () => {
  await assertRejects(
    () =>
      resolveAgentConfig(
        "missing.yaml",
        (n) => (n === "LOOPED_AGENT_CONFIG" ? MINIMAL : undefined),
      ),
    ConfigError,
    "renamed to AF_AGENT_CONFIG",
  );
});

Deno.test("tools.custom is rejected, pointing at MCP", () => {
  const err = assertThrows(
    () => parseAgentConfig(MINIMAL + `tools:\n  custom: [./my-tool.ts]\n`),
    ConfigError,
  );
  assert(err.message.includes("MCP"));
});

Deno.test("the shipped agent-zero-bot example is a valid agent definition", async () => {
  const path = new URL("../../../examples/agent-zero-bot/agent.yaml", import.meta.url);
  const config = parseAgentConfig(await Deno.readTextFile(path), "examples/agent-zero-bot");
  assertEquals(config.handle, "agent-zero-bot");
  assertEquals(config.permissions?.write, ["agents"]);
});

Deno.test("parses config-defined commands", () => {
  const config = parseAgentConfig(
    MINIMAL +
      `commands:\n  - name: standup\n    description: Summarize the last day of activity\n    prompt: "Summarize. Focus: $ARGS"\n`,
  );
  assertEquals(config.commands?.length, 1);
  assertEquals(config.commands?.[0].name, "standup");
});

Deno.test("rejects a command that shadows a built-in", () => {
  const err = assertThrows(
    () =>
      parseAgentConfig(
        MINIMAL + `commands:\n  - name: reset\n    description: Nope nope\n    prompt: x\n`,
      ),
    ConfigError,
  );
  assert(err.message.includes("built-in"));
});

Deno.test("rejects duplicate command names", () => {
  assertThrows(
    () =>
      parseAgentConfig(
        MINIMAL +
          `commands:\n  - name: a_cmd\n    description: First one\n    prompt: x\n  - name: a_cmd\n    description: Second one\n    prompt: y\n`,
      ),
    ConfigError,
  );
});

Deno.test("rejects command names no platform would register", () => {
  assertThrows(
    () =>
      parseAgentConfig(
        MINIMAL +
          `commands:\n  - name: Bad-Name\n    description: Hyphens and caps\n    prompt: x\n`,
      ),
    ConfigError,
  );
});

Deno.test("chat transports: defaults apply, telegram webhook demands a https public_url", () => {
  const telegram = parseAgentConfig(MINIMAL + "triggers:\n  - type: telegram\n");
  assertEquals(telegram.triggers?.[0], {
    type: "telegram",
    transport: "polling",
    token_env: "TELEGRAM_BOT_TOKEN",
    allow_silence: false,
    port: 8080,
    path: "/telegram",
  });

  const webhook = parseAgentConfig(
    MINIMAL +
      "triggers:\n  - type: telegram\n    transport: webhook\n    public_url: https://agent.example\n",
  ).triggers?.[0];
  assert(webhook?.type === "telegram" && webhook.public_url === "https://agent.example");

  // webhook without a public_url has nowhere to register; polling with one
  // would silently never use it; Telegram only delivers over HTTPS.
  assertThrows(
    () => parseAgentConfig(MINIMAL + "triggers:\n  - type: telegram\n    transport: webhook\n"),
    ConfigError,
  );
  assertThrows(
    () =>
      parseAgentConfig(
        MINIMAL + "triggers:\n  - type: telegram\n    public_url: https://agent.example\n",
      ),
    ConfigError,
  );
  assertThrows(
    () =>
      parseAgentConfig(
        MINIMAL +
          "triggers:\n  - type: telegram\n    transport: webhook\n    public_url: http://agent.example\n",
      ),
    ConfigError,
  );

  const slack = parseAgentConfig(
    MINIMAL + "triggers:\n  - type: slack\n    transport: events_api\n",
  ).triggers?.[0];
  assert(slack?.type === "slack");
  assertEquals(slack.transport, "events_api");
  assertEquals(slack.path, "/slack");
  assertEquals(slack.signing_secret_env, "SLACK_SIGNING_SECRET");
});

Deno.test("requiredEnvRefs: purpose refs, http.auth refs, and *_env names join the list", () => {
  const config = parseAgentConfig(`
handle: refs-bot
description: env refs test agent
model:
  provider: openai-compatible
  id: test-model
purpose: The project id is \${PROJECT_ID}.
triggers:
  - type: tty
    token_env: TTY_TOKEN
permissions:
  net: [api.example.com]
http:
  auth:
    - url: https://api.example.com
      value: Bearer \${EXAMPLE_KEY}
`);
  assertEquals(requiredEnvRefs(config), [
    "EXAMPLE_KEY",
    "OPENAI_API_KEY",
    "PROJECT_ID",
    "TTY_TOKEN",
  ]);
  // collectEnvRefs keeps its narrower, secrets-oriented view.
  assertEquals(collectEnvRefs(config), ["OPENAI_API_KEY"]);
});

Deno.test("loadAgentConfig refuses a file that asks past the operator's floor", async () => {
  const dir = await Deno.makeTempDir();
  const floorPath = `${dir}/floor.yaml`;
  const agentPath = `${dir}/agent.yaml`;
  await Deno.writeTextFile(floorPath, "run: [gh, jq]\ndeny:\n  net: [metadata.google.internal]\n");
  await Deno.writeTextFile(
    agentPath,
    `handle: floored
description: an agent asking for too much
model:
  provider: anthropic
  id: claude-opus-5
purpose: You do a job.
permissions:
  run: [gh, curl]
  net: ["*.google.internal"]
`,
  );

  Deno.env.set(FLOOR_ENV, floorPath);
  try {
    const err = await assertRejects(() => loadAgentConfig(agentPath), ConfigError);
    // Both problems are named at once: fixing one and rediscovering the other
    // on the next start is the wrong shape for a startup check.
    assert(err.message.includes('permissions.run asks for "curl"'));
    assert(err.message.includes('permissions.net asks for "*.google.internal"'));
    assert(err.message.includes("deny.net"));
    // The grants the floor allows are not mentioned.
    assert(!err.message.includes('"gh"'));

    // Narrowing the agent file is the fix; the floor never grants anything.
    await Deno.writeTextFile(
      agentPath,
      `handle: floored
description: an agent within the floor
model:
  provider: anthropic
  id: claude-opus-5
purpose: You do a job.
permissions:
  run: [gh]
`,
    );
    const config = await loadAgentConfig(agentPath);
    // The file's grants stand exactly as written: the floor refuses, never rewrites.
    assertEquals(config.permissions?.run, ["gh"]);
  } finally {
    Deno.env.delete(FLOOR_ENV);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("whatsapp: defaults apply, and both URLs have to be https", () => {
  const WA = 'triggers:\n  - type: whatsapp\n    phone_number_id: "123"\n' +
    "    public_url: https://agent.example\n";
  const wa = parseAgentConfig(MINIMAL + WA).triggers?.[0];
  assertEquals(wa, {
    type: "whatsapp",
    phone_number_id: "123",
    public_url: "https://agent.example",
    token_env: "WHATSAPP_TOKEN",
    app_secret_env: "WHATSAPP_APP_SECRET",
    verify_token_env: "WHATSAPP_VERIFY_TOKEN",
    port: 8080,
    path: "/whatsapp",
    allow_silence: false,
    graph_version: "v26.0",
    out_of_window_template_language: "en_US",
    mark_read: false,
  });

  // The Cloud API is webhook-only, so there is no transport that works
  // without somewhere for Meta to deliver to.
  assertThrows(
    () => parseAgentConfig(MINIMAL + 'triggers:\n  - type: whatsapp\n    phone_number_id: "1"\n'),
    ConfigError,
  );
  assertThrows(
    () =>
      parseAgentConfig(
        MINIMAL + 'triggers:\n  - type: whatsapp\n    phone_number_id: "1"\n' +
          "    public_url: http://agent.example\n",
      ),
    ConfigError,
  );
  // The access token rides every Graph call, so a plaintext base would put a
  // long-lived credential on the wire — and the hermetic allowlist is derived
  // from this value, so a bad base would authorise itself.
  assertThrows(
    () => parseAgentConfig(MINIMAL + WA + "    api_base: http://graph.example\n"),
    ConfigError,
  );
  const aggregator = parseAgentConfig(
    MINIMAL + WA + "    api_base: https://waba-v2.360dialog.io\n",
  ).triggers?.[0];
  assert(aggregator?.type === "whatsapp");
  assertEquals(aggregator.api_base, "https://waba-v2.360dialog.io");

  // A pinned Graph version, so a channel never silently follows latest.
  assertThrows(() => parseAgentConfig(MINIMAL + WA + "    graph_version: 26\n"), ConfigError);
});
