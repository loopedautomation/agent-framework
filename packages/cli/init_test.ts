import { assert, assertEquals } from "@std/assert";
import { parseAgentConfig } from "@looped/af";
import { DEPLOYS, generateProject, type InitOptions, PROVIDERS, TRIGGERS } from "./init.ts";

const BASE: InitOptions = {
  nickname: "test-agent",
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
          const config = parseAgentConfig(files["agent.yaml"], "generated");
          assertEquals(config.nickname, "test-agent");
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
  assert(envDeploy["README.md"].includes("LOOPED_AGENT_CONFIG"));
  assert(!("Dockerfile" in envDeploy));
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
