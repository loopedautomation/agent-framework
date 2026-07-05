// `af update` — reinstall the CLI from JSR at its latest published version.
// Mirrors the install command from the README, with -f to overwrite the
// existing binary and @latest to bypass any cached resolution.

import { fail } from "./docker_commands.ts";
import { ok, Spinner } from "./style.ts";

const INSTALL_ARGS = [
  "install",
  "-g",
  "-f",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-net",
  "--allow-run=bash,docker",
  "-n",
  "af",
  "jsr:@looped/af@latest",
];

export async function update() {
  const spinner = new Spinner();
  spinner.start("updating af...");
  try {
    const child = new Deno.Command("deno", {
      args: INSTALL_ARGS,
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    });
    const out = await child.output();
    if (out.code !== 0) {
      spinner.stop();
      fail(new TextDecoder().decode(out.stderr).trim() || "deno install failed");
    }
    spinner.stop(`${ok("✓")} af is up to date`);
  } catch (e) {
    spinner.stop();
    if (e instanceof Deno.errors.NotFound) {
      fail("deno not found — af update reinstalls via `deno install`");
    }
    throw e;
  }
}
