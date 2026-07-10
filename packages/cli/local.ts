// In-container / local execution — validate, repl, serve, and the container
// entrypoint (runLocal). This branch IS what the published image runs.

import {
  type AgentConfig,
  AgentService,
  collectEnvRefs,
  permissionsToDenoFlags,
  resolveAgentConfig,
  type RunResult,
  startStatusServer,
} from "@looped/core";
import { triggersFromConfig } from "@looped/triggers";
import { printBirthBanner } from "./banner.ts";
import { accent, dim, ok, warn } from "./style.ts";
import { tui } from "./tui/tui.ts";

function statusLine(result: RunResult): string {
  return `[${result.status} · ${result.steps} step${result.steps === 1 ? "" : "s"} · ` +
    `${result.usage.inputTokens}in/${result.usage.outputTokens}out tokens]`;
}

export async function validate(path: string) {
  const config = await resolveAgentConfig(path);
  console.log(`${ok("✓")} ${path} is a valid agent definition`);
  console.log(`  handle:   ${accent(config.handle)}`);
  console.log(`  model:    ${config.model.provider} / ${config.model.id}`);
  console.log(`  triggers: ${config.triggers?.map((t) => t.type).join(", ") ?? "none (CLI only)"}`);
  const flags = permissionsToDenoFlags(config.permissions);
  if (flags.length) console.log(`  sandbox:  ${flags.join(" ")}`);
  const refs = collectEnvRefs(config);
  if (refs.length) {
    const missing = refs.filter((name) => Deno.env.get(name) === undefined);
    console.log(`  env refs: ${refs.join(", ")}`);
    if (missing.length) {
      console.log(`  ${warn("⚠")} not set in this environment: ${missing.join(", ")}`);
    }
  }
}

/** The plain line-at-a-time loop, for piped stdin and dumb terminals. */
async function repl(config: AgentConfig, service: AgentService, name: string) {
  console.log(
    `${name} (${config.handle}) is listening (model: ${config.model.id}; ctrl-d to exit)`,
  );
  const conversationKey = config.memory?.scope === "thread" ? "cli" : undefined;
  while (true) {
    const input = prompt("you>");
    if (input === null) break; // EOF
    if (!input.trim()) continue;
    const result = await service.handle({
      id: crypto.randomUUID(),
      trigger: "cli",
      input,
      conversationKey,
    });
    console.log(`\n${name}> ${result.reply}\n`);
    console.log(dim(statusLine(result)));
  }
}

async function serve(config: AgentConfig, service: AgentService, name: string) {
  const triggers = triggersFromConfig(config);
  await service.start(triggers);
  const status = startStatusServer(service);
  console.log(
    `${name} (${config.handle}) is running as a service ` +
      `(triggers: ${config.triggers!.map((t) => t.type).join(", ")}; ctrl-c to stop)`,
  );
  await new Promise<void>((resolve) => {
    Deno.addSignalListener("SIGINT", () => resolve());
    Deno.addSignalListener("SIGTERM", () => resolve());
  });
  console.log("\nshutting down...");
  await status.shutdown();
  await service.stop();
}

/** In-process execution: only inside the container (or AF_CONTAINER=1 for framework dev). */
export async function runLocal(path: string) {
  const config = await resolveAgentConfig(path);
  const baseDir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  const service = new AgentService({ config, baseDir });
  const identity = await service.init();
  if (identity.isNew) printBirthBanner(config.handle, identity.name);
  if (config.triggers?.length) await serve(config, service, identity.name);
  else if (Deno.stdin.isTerminal() && Deno.stdout.isTerminal()) {
    await tui({ config, service });
  } else await repl(config, service, identity.name);
}
