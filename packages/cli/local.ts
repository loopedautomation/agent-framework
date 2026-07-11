// In-container / local execution — validate, repl, serve, and the container
// entrypoint (runLocal). This branch IS what the published image runs.

import {
  type AgentConfig,
  AgentService,
  collectEnvRefs,
  hermeticPlan,
  IMAGE_ENV,
  resolveAgentConfig,
  type RunResult,
  startStatusServer,
} from "@looped/core";
import { triggersFromConfig } from "@looped/triggers";
import { dirname, fromFileUrl, resolve } from "@std/path";
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
  const plan = hermeticPlan(config, IMAGE_ENV);
  if (plan.eligible) {
    console.log(`  sandbox:  hermetic — Deno enforces net for the whole process`);
    console.log(`  egress:   ${plan.hosts.join(", ")}`);
  } else {
    console.log(`  sandbox:  net open below the app layer; egress bounded by the container`);
    for (const blocker of plan.blockers) console.log(`  ${warn("⚠")} ${blocker}`);
  }
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
    `${name} (${config.handle}) is listening (model: ${config.model.id}; /help for commands; ctrl-d to exit)`,
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

/**
 * Re-exec the runtime under the agent's own Deno flags, so `permissions.net`
 * is enforced by the sandbox instead of by the http_request tool alone.
 *
 * This runs before the service exists — before a provider, trigger or MCP
 * client has opened a socket — because flags can only be chosen at process
 * start. The child is marked so it doesn't re-exec again, and signals are
 * forwarded so `docker stop` still reaches the agent.
 *
 * Returns false when the process should keep going as it is: an agent that
 * spawns subprocesses can't be held by the Deno layer (they escape it), so it
 * stays on the image's flags with the container as its egress boundary.
 */
async function reexecHermetic(config: AgentConfig, path: string): Promise<boolean> {
  const plan = hermeticPlan(config, Deno.env.get, [dirname(resolve(path)), Deno.cwd()]);
  if (!plan.eligible) {
    console.log(
      dim(`sandbox: net open below the app layer — ${plan.blockers[0]}. Egress: the container.`),
    );
    return false;
  }

  const child = new Deno.Command("deno", {
    args: ["run", ...plan.flags, fromFileUrl(Deno.mainModule), ...Deno.args],
    env: { AF_HERMETIC: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  const forward = (signal: Deno.Signal) => () => child.kill(signal);
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  Deno.addSignalListener("SIGINT", onInt);
  Deno.addSignalListener("SIGTERM", onTerm);
  const status = await child.status;
  Deno.removeSignalListener("SIGINT", onInt);
  Deno.removeSignalListener("SIGTERM", onTerm);
  Deno.exit(status.code);
}

/** In-process execution: only inside the container (or AF_CONTAINER=1 for framework dev). */
export async function runLocal(path: string) {
  const config = await resolveAgentConfig(path);

  // Hermetic mode is the container's business: on a dev machine there are no
  // image flags to narrow, and re-execing would only confuse the REPL.
  if (Deno.env.get("AF_CONTAINER") && !Deno.env.get("AF_HERMETIC")) {
    await reexecHermetic(config, path);
  } else if (Deno.env.get("AF_HERMETIC")) {
    console.log(dim(`sandbox: hermetic — ${hermeticPlan(config).hosts.join(", ")}`));
  }

  const baseDir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  const service = new AgentService({ config, baseDir });
  const identity = await service.init();
  if (identity.isNew) printBirthBanner(config.handle, identity.name);
  if (config.triggers?.length) await serve(config, service, identity.name);
  else if (Deno.stdin.isTerminal() && Deno.stdout.isTerminal()) {
    await tui({ config, service });
  } else await repl(config, service, identity.name);
}
