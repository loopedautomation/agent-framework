// af init — scaffold a new agent project by prompting for (or reading flags for)
// handle, trigger, provider, deploy target, and required CLIs.

import { DEPLOYS, generateProject, type InitOptions, PROVIDERS, TRIGGERS } from "./init.ts";
import { ok } from "./style.ts";
import { fail } from "./docker_commands.ts";

function flag(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

function choose<T extends string>(label: string, options: readonly T[], flagValue?: string): T {
  if (flagValue) {
    if ((options as readonly string[]).includes(flagValue)) return flagValue as T;
    fail(`--${label} must be one of: ${options.join(", ")}`);
  }
  console.log(`${label}:`);
  options.forEach((option, i) => console.log(`  ${i + 1}. ${option}`));
  const picked = prompt(`choose [1-${options.length}]:`) ?? "";
  const index = Number(picked) - 1;
  if (!options[index]) fail(`pick a number between 1 and ${options.length}`);
  return options[index];
}

export function init(nameArg?: string) {
  const handle = nameArg ?? flag("handle") ??
    prompt("handle (lowercase, hyphens — what you'll call the agent):") ?? "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(handle)) {
    fail("handle must be lowercase alphanumeric with hyphens");
  }
  const trigger = choose("trigger", TRIGGERS, flag("trigger"));
  const provider = choose("provider", PROVIDERS, flag("provider"));
  const deploy = choose("deploy", DEPLOYS, flag("deploy"));
  const clis =
    (flag("clis") ?? prompt("CLIs the agent needs (comma-separated, empty for none):") ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);

  const options: InitOptions = { handle, trigger, provider, model: flag("model"), clis, deploy };
  const files = generateProject(options);

  const target = `${flag("dir") ?? "."}/${handle}`;
  try {
    if ([...Deno.readDirSync(target)].length) fail(`${target} exists and is not empty`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  Deno.mkdirSync(target, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    Deno.writeTextFileSync(`${target}/${name}`, content);
  }
  console.log(`\n${ok("✓")} ${target}/ scaffolded:`);
  for (const name of Object.keys(files)) console.log(`    ${name}`);
  const todoFile = "agent.yaml" in files ? "agent.yaml" : "compose.yaml";
  console.log(
    `\nnext: fill in the TODOs in ${target}/${todoFile}, then follow ${target}/README.md`,
  );
}
