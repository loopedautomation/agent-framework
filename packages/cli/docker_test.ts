import { assert, assertEquals } from "@std/assert";
import { parseAgentConfig } from "@looped/core";
import {
  containerName,
  DEFAULT_IMAGE,
  dockerPsArgs,
  dockerRmArgs,
  dockerRunArgs,
  dockerStopArgs,
  parsePsLine,
  volumeName,
  webhookPorts,
} from "./docker.ts";
import { setColorEnabled, table, visibleLength } from "./style.ts";

const CONFIG = parseAgentConfig(`
handle: issue-bot
description: test agent
model:
  provider: openai-compatible
  id: gpt-5.4-mini
purpose: test
skills:
  - ./skills/gh-issues.md
`);

const OPTS = { configPath: "/proj/issue-bot/agent.yaml", envFile: "/proj/issue-bot/.env" };

/** The value following a flag, asserting the flag is present. */
function valueOf(args: string[], flag: string, match?: (v: string) => boolean): string {
  const values = args.flatMap((a, i) => a === flag ? [args[i + 1]] : []);
  const hit = match ? values.find(match) : values[0];
  assert(
    hit !== undefined,
    `${flag} ${match ? "matching value" : ""} missing in: ${args.join(" ")}`,
  );
  return hit;
}

Deno.test("dockerRunArgs: config mount, skills mount, data volume, env file, image", () => {
  const args = dockerRunArgs(CONFIG, { mode: "detached", ...OPTS });
  assertEquals(args[0], "run");
  assertEquals(valueOf(args, "--name"), "af-issue-bot");
  assert(args.includes("--label") && args.includes("af.agent=issue-bot"));
  valueOf(args, "-v", (v) => v === "/proj/issue-bot/agent.yaml:/agent/agent.yaml:ro");
  valueOf(
    args,
    "-v",
    (v) => v === "/proj/issue-bot/skills/gh-issues.md:/agent/skills/gh-issues.md:ro",
  );
  valueOf(args, "-v", (v) => v === "issue-bot-data:/data");
  assertEquals(valueOf(args, "--env-file"), "/proj/issue-bot/.env");
  assertEquals(args.at(-1), DEFAULT_IMAGE);
});

Deno.test("dockerRunArgs: parent-relative skill paths normalize on both sides", () => {
  const config = parseAgentConfig(`
handle: shared-skill
description: t
model: {provider: openai-compatible, id: m}
purpose: t
skills:
  - ../../skills/gh-issues.md
`);
  const args = dockerRunArgs(config, {
    mode: "detached",
    configPath: "/repo/examples/bot/agent.yaml",
  });
  valueOf(args, "-v", (v) => v === "/repo/skills/gh-issues.md:/skills/gh-issues.md:ro");
});

Deno.test("dockerRunArgs: mode differences", () => {
  const interactive = dockerRunArgs(CONFIG, { mode: "interactive", ...OPTS });
  assert(interactive.includes("-i") && interactive.includes("-t") && interactive.includes("--rm"));
  assert(!interactive.includes("--restart"));

  const noTty = dockerRunArgs(CONFIG, { mode: "interactive", ...OPTS, tty: false });
  assert(noTty.includes("-i") && !noTty.includes("-t"));

  const attached = dockerRunArgs(CONFIG, { mode: "attached", ...OPTS });
  assert(attached.includes("--rm") && !attached.includes("-d") && !attached.includes("-i"));

  const detached = dockerRunArgs(CONFIG, { mode: "detached", ...OPTS });
  assert(detached.includes("-d") && !detached.includes("--rm"));
  assertEquals(valueOf(detached, "--restart"), "unless-stopped");
});

Deno.test("dockerRunArgs: hardening and status port always present", () => {
  for (const mode of ["interactive", "attached", "detached"] as const) {
    const args = dockerRunArgs(CONFIG, { mode, ...OPTS });
    assert(args.includes("--read-only"), `${mode} missing --read-only`);
    assertEquals(valueOf(args, "--tmpfs"), "/tmp");
    valueOf(args, "-p", (v) => v === "127.0.0.1:0:9090");
  }
});

Deno.test("dockerRunArgs: webhook triggers publish their port; image override wins", () => {
  const webhook = parseAgentConfig(`
handle: hook-bot
description: t
model: {provider: openai-compatible, id: m}
purpose: t
triggers:
  - type: webhook
    token_env: WEBHOOK_TOKEN
    port: 9000
`);
  assertEquals(webhookPorts(webhook), [9000]);
  const args = dockerRunArgs(webhook, {
    mode: "detached",
    configPath: "/a/agent.yaml",
    image: "myorg/agent:dev",
  });
  valueOf(args, "-p", (v) => v === "9000:9000");
  assertEquals(args.at(-1), "myorg/agent:dev");
  assert(!args.includes("--env-file")); // no env file, no flag
});

Deno.test("naming and lifecycle argv", () => {
  assertEquals(containerName("issue-bot"), "af-issue-bot");
  assertEquals(volumeName("issue-bot"), "issue-bot-data");
  assertEquals(dockerStopArgs(["a", "b"]), ["stop", "af-a", "af-b"]);
  assertEquals(dockerRmArgs(["a"]), ["rm", "af-a"]);
  assert(dockerPsArgs().join(" ").includes("label=af.agent"));
});

Deno.test("parsePsLine: extracts handle, state, and the 9090 mapping", () => {
  const entry = parsePsLine(JSON.stringify({
    Names: "af-issue-bot",
    State: "running",
    Status: "Up 5 minutes",
    Ports: "127.0.0.1:55031->9090/tcp, 8080/tcp",
    Labels: "af.agent=issue-bot,af.config=/proj/agent.yaml",
  }));
  assertEquals(entry, {
    handle: "issue-bot",
    state: "running",
    status: "Up 5 minutes",
    statusAddr: "127.0.0.1:55031",
  });
  assertEquals(parsePsLine("not json"), undefined);
  assertEquals(parsePsLine(JSON.stringify({ Labels: "other=x" })), undefined);
});

Deno.test("table: pads by visible width, ANSI ignored", () => {
  setColorEnabled(true);
  const styled = "\x1b[38;2;34;211;238mhi\x1b[39m";
  assertEquals(visibleLength(styled), 2);
  const rows = table([[styled, "x"], ["long-cell", "y"]]);
  assertEquals(rows[1], "long-cell  y");
  // "hi" padded to 9 visible chars before the second column
  assert(rows[0].endsWith("        x"));
  setColorEnabled(false);
});

Deno.test("style helpers: plain text when color is off", async () => {
  setColorEnabled(false);
  const { accent, dim, ok } = await import("./style.ts");
  assertEquals(accent("x"), "x");
  assertEquals(dim("x"), "x");
  assertEquals(ok("x"), "x");
});
