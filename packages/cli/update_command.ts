// `af update` — reinstall the CLI from JSR at its latest published version.
// Mirrors the install command from the README, with -f to overwrite the
// existing binary and @latest to bypass any cached resolution.
//
// A Homebrew (or otherwise `deno compile`d) install is a standalone binary,
// not a `deno install` shim — reinstalling via `deno install` would require
// Deno and shadow the brew-managed binary. Detect that case and point the
// user at their package manager instead.

import { fail } from "./docker_commands.ts";
import { ok, Spinner } from "./style.ts";

// A `deno install` shim (and `deno task af` in dev) runs under the `deno`
// executable, so execPath's basename is `deno`. A `deno compile` binary runs
// as itself, so the basename is `af` (or whatever it was renamed to).
function isStandaloneBinary(): boolean {
  const base = Deno.execPath().split(/[/\\]/).pop() ?? "";
  return base.replace(/\.exe$/i, "").toLowerCase() !== "deno";
}

const INSTALL_ARGS = [
  "install",
  "-g",
  "-f",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-net",
  "--allow-run=bash,docker,deno",
  "-n",
  "af",
  "jsr:@looped/af@latest",
];

export async function update() {
  if (isStandaloneBinary()) {
    console.log(
      "af is installed as a standalone binary (e.g. Homebrew).\n" +
        "Update it with your package manager instead:\n\n" +
        "  brew upgrade af",
    );
    return;
  }
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
