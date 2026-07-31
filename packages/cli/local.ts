// In-container / local execution — validate, repl, serve, and the container
// entrypoint (runLocal). This branch IS what the published image runs.

import {
  type AgentConfig,
  AgentService,
  expandConfigHosts,
  hermeticPlan,
  IMAGE_ENV,
  inertDeclarations,
  requiredEnvRefs,
  resolveAgentConfig,
  runGrantAdvisories,
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
  // Lenient: validate describes a config, and it is routinely run somewhere
  // other than the host that holds the deployment's env. An unresolved
  // ${VAR} host stays visible in the egress line rather than failing here —
  // the "not set in this environment" warning below is what reports it.
  const config = expandConfigHosts(await resolveAgentConfig(path), { lenient: true });
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
  for (const advisory of runGrantAdvisories(config.permissions?.run)) {
    console.log(`  ${warn("⚠")} ${advisory.advice}`);
  }
  for (const inert of inertDeclarations(config)) {
    console.log(`  ${warn("⚠")} ${inert.advice}`);
  }
  const refs = requiredEnvRefs(config);
  if (refs.length) {
    const missing = refs.filter((name) => Deno.env.get(name) === undefined);
    console.log(`  env refs: ${refs.join(", ")}`);
    if (missing.length) {
      console.log(`  ${warn("⚠")} not set in this environment: ${missing.join(", ")}`);
    }
  }
}

/**
 * One line of input at a time: prompt() on a TTY, a plain line reader when
 * stdin is piped — prompt() returns null off-TTY, so a piped run would
 * otherwise exit after the header without handling anything.
 */
async function* inputLines(): AsyncGenerator<string> {
  if (Deno.stdin.isTerminal()) {
    while (true) {
      const input = prompt("you>");
      if (input === null) return; // EOF
      yield input;
    }
  }
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Deno.stdin.readable) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) yield line.endsWith("\r") ? line.slice(0, -1) : line;
  }
  if (buf) yield buf;
}

/**
 * The plain line-at-a-time loop, for piped stdin and dumb terminals. Piped
 * stdin makes this a one-shot mode: each line is handled in order and the
 * process exits on EOF, so `echo "..." | af run agent.yaml` runs once and
 * leaves — what CI wants.
 */
async function repl(config: AgentConfig, service: AgentService, name: string) {
  console.log(
    `${name} (${config.handle}) is listening (model: ${config.model.id}; /help for commands; ctrl-d to exit)`,
  );
  const conversationKey = config.memory?.scope === "thread" ? "cli" : undefined;
  for await (const input of inputLines()) {
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
  const triggers = triggersFromConfig(config, undefined, name);
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
  // The grace period after SIGTERM used to be spent exiting. Spend it
  // finishing instead: stop accepting events, let the accepted ones run, and
  // keep the status surface up so a deployment can watch the drain.
  const inFlight = service.inFlight;
  console.log(
    inFlight > 0
      ? `\ndraining ${inFlight} run${inFlight === 1 ? "" : "s"} ` +
        `(up to ${config.limits.drain_timeout}s)...`
      : "\nshutting down...",
  );
  const remaining = await service.drain();
  if (remaining > 0) {
    console.log(
      `${remaining} run${remaining === 1 ? "" : "s"} did not finish in time; ` +
        `they are recorded and will be marked crashed at next start`,
    );
  }
  await status.shutdown();
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
  // Before anything reads permissions.net — the hermetic re-exec compiles it
  // into --allow-net, and a host still holding ${VAR} would allowlist a
  // literal no DNS name matches. Strict here: a missing host fails at
  // startup, like every other env reference on a running path.
  const config = expandConfigHosts(await resolveAgentConfig(path));

  // Hermetic mode is the container's business: on a dev machine there are no
  // image flags to narrow, and re-execing would only confuse the REPL.
  if (Deno.env.get("AF_CONTAINER") && !Deno.env.get("AF_HERMETIC")) {
    await reexecHermetic(config, path);
  } else if (Deno.env.get("AF_HERMETIC")) {
    console.log(dim(`sandbox: hermetic — ${hermeticPlan(config).hosts.join(", ")}`));
  }

  for (const advisory of runGrantAdvisories(config.permissions?.run)) {
    console.log(`${warn("⚠")} ${advisory.advice}`);
  }
  for (const inert of inertDeclarations(config)) {
    console.log(`${warn("⚠")} ${inert.advice}`);
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
