import { assert, assertEquals } from "@std/assert";
import { parseAgentConfig } from "@looped/core";
import { DEPLOYS, generateProject, type InitOptions, PROVIDERS, TRIGGERS } from "./init.ts";

const BASE: InitOptions = {
  handle: "test-agent",
  trigger: "webhook",
  provider: "openai-compatible",
  clis: [],
  deploy: "compose",
};

Deno.test("every option combination generates a schema-valid agent.yaml", () => {
  for (const trigger of TRIGGERS) {
    for (const provider of PROVIDERS) {
      for (const deploy of DEPLOYS) {
        for (const clis of [[], ["gh", "jq"]]) {
          const files = generateProject({ ...BASE, trigger, provider, deploy, clis });
          if (deploy === "compose-inline") {
            assert("compose.yaml" in files); // embedded validity covered below
            continue;
          }
          const config = parseAgentConfig(files["agent.yaml"], "generated");
          assertEquals(config.handle, "test-agent");
          if (clis.length) assertEquals(config.permissions?.run, ["gh", "jq"]);
          if (trigger !== "none") assertEquals(config.triggers?.[0].type, trigger);
        }
      }
    }
  }
});

Deno.test("env example derives from provider and trigger", () => {
  const files = generateProject({ ...BASE, trigger: "discord", provider: "anthropic" });
  assert(files[".env.example"].includes("ANTHROPIC_API_KEY="));
  assert(files[".env.example"].includes("DISCORD_BOT_TOKEN="));
  assert(!files[".env.example"].includes("OPENAI"));

  const local = generateProject({ ...BASE, provider: "local", trigger: "none" });
  assert(!local[".env.example"].includes("API_KEY")); // local endpoints need no key
});

Deno.test("deployment shapes produce the right files", () => {
  const local = generateProject({ ...BASE, deploy: "local" });
  assertEquals(Object.keys(local).sort(), [".env.example", "README.md", "agent.yaml"]);

  const compose = generateProject({ ...BASE, deploy: "compose" });
  assert("compose.yaml" in compose && ".gitignore" in compose);
  assert(compose["compose.yaml"].includes("image: ghcr.io/")); // no clis → stock image + mount
  assert(compose["compose.yaml"].includes("test-agent-data:/data"));

  const withClis = generateProject({ ...BASE, deploy: "paas-git", clis: ["gh"] });
  assert(withClis["Dockerfile"].includes("apk add --no-cache gh"));
  assert(withClis["compose.yaml"].includes("build: .")); // clis → baked image

  const envDeploy = generateProject({ ...BASE, deploy: "paas-env" });
  assert(envDeploy["README.md"].includes("AF_AGENT_CONFIG"));
  assert(!("Dockerfile" in envDeploy));
});

Deno.test("a custom-built image gets an explicit lowercase tag (uppercase handle)", () => {
  // docker compose won't lowercase the image name it derives from a service
  // name when `build:` has no `image:` alongside it — an uppercase handle
  // would otherwise produce a tag docker rejects.
  const files = generateProject({
    ...BASE,
    handle: "TestAgent",
    deploy: "compose",
    clis: ["gh"],
  });
  assert(files["compose.yaml"].includes("image: testagent"));
  assert(!files["compose.yaml"].includes("image: TestAgent"));
});

Deno.test("webhook agents expose the trigger port; others don't", () => {
  const hook = generateProject({ ...BASE, trigger: "webhook", deploy: "compose" });
  assert(hook["compose.yaml"].includes('"8080:8080"'));
  const cron = generateProject({ ...BASE, trigger: "cron", deploy: "compose" });
  assert(!cron["compose.yaml"].includes('"8080:8080"'));
});

Deno.test("all generated agent.yamls carry the schema modeline", () => {
  const files = generateProject(BASE);
  assert(files["agent.yaml"].startsWith("# yaml-language-server: $schema="));
});

Deno.test("compose-inline: one file, embedded config is schema-valid", () => {
  const files = generateProject({ ...BASE, deploy: "compose-inline" });
  assert(!("agent.yaml" in files) && !("Dockerfile" in files));
  const compose = files["compose.yaml"];
  // The config is a top-level configs element mounted at /agent/agent.yaml,
  // not an env var — configuration stays out of the environment.
  assert(!compose.includes("AF_AGENT_CONFIG"));
  assert(compose.includes("target: /agent/agent.yaml"));
  // Extract the block scalar under content: and dedent it.
  const start = compose.indexOf("content: |");
  const block = compose.slice(start).split("\n").slice(1);
  const embedded: string[] = [];
  for (const line of block) {
    if (line === "" || line.startsWith("      ")) embedded.push(line.slice(6));
    else break;
  }
  const config = parseAgentConfig(embedded.join("\n"), "embedded");
  assertEquals(config.handle, "test-agent");
  assertEquals(config.triggers?.[0].type, "webhook");
});

Deno.test("init: the generated compose gives the agent no way out except the proxy", () => {
  const files = generateProject({
    ...BASE,
    handle: "egress-bot",
    provider: "anthropic",
    trigger: "cron",
    deploy: "compose",
  });
  const compose = files["docker-compose.yml"] ?? files["compose.yaml"];
  assert(compose !== undefined, `no compose file in ${Object.keys(files).join(", ")}`);

  // The agent is on the internal network only. That network has no route off
  // the host, so a subprocess ignoring HTTP_PROXY has nowhere to send packets.
  assert(compose.includes("egress-bot-internal:"));
  assert(compose.includes("    internal: true"));

  // The proxy is the one service on both networks.
  assert(compose.includes("  egress-bot-egress:"));
  assert(compose.includes('command: ["egress", "/agent/agent.yaml"]'));

  // And the polite path points at it, for everything that does honour it.
  assert(compose.includes("HTTP_PROXY: http://egress-bot-egress:3128"));
  assert(compose.includes("HTTPS_PROXY: http://egress-bot-egress:3128"));
  // The proxy itself must stay reachable without recursing through itself.
  assert(compose.includes("NO_PROXY: localhost,127.0.0.1,egress-bot-egress"));
});
