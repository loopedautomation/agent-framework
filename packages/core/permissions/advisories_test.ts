import { assertEquals } from "@std/assert";
import { runGrantAdvisories } from "./advisories.ts";

Deno.test("advisories: no run grants, no advisories", () => {
  assertEquals(runGrantAdvisories(undefined), []);
  assertEquals(runGrantAdvisories([]), []);
});

Deno.test("advisories: ordinary CLIs pass clean", () => {
  assertEquals(runGrantAdvisories(["grep", "jq", "ls", "cat", "sed"]), []);
});

Deno.test("advisories: shells and interpreters collapse the allowlist", () => {
  for (const entry of ["bash", "sh", "python3", "node", "deno"]) {
    const advisories = runGrantAdvisories([entry]);
    assertEquals(advisories.length, 1);
    assertEquals(advisories[0].entry, entry);
    assertEquals(advisories[0].hazard, "shell");
  }
});

Deno.test("advisories: wrappers carry the real command in their arguments", () => {
  for (const entry of ["env", "xargs", "timeout", "find", "npx"]) {
    assertEquals(runGrantAdvisories([entry])[0].hazard, "wrapper");
  }
});

Deno.test("advisories: network-capable binaries bypass permissions.net", () => {
  for (const entry of ["curl", "wget", "ssh", "gh", "git"]) {
    const advisories = runGrantAdvisories([entry]);
    assertEquals(advisories[0].hazard, "net");
    assertEquals(advisories[0].advice.includes("permissions.net"), true);
  }
});

Deno.test("advisories: * is flagged as the loudest grant of all", () => {
  const advisories = runGrantAdvisories(["*"]);
  assertEquals(advisories.length, 1);
  assertEquals(advisories[0].entry, "*");
  assertEquals(advisories[0].hazard, "shell");
});

Deno.test("advisories: entries are judged by basename, like the engine matches", () => {
  // engine.run() matches executables by basename, so /usr/bin/bash in the
  // config is the same grant as bash — the advisory must see through it too.
  const advisories = runGrantAdvisories(["/usr/bin/bash"]);
  assertEquals(advisories.length, 1);
  assertEquals(advisories[0].entry, "/usr/bin/bash");
  assertEquals(advisories[0].hazard, "shell");
});

Deno.test("advisories: config order is preserved, clean entries interleaved silently", () => {
  const advisories = runGrantAdvisories(["gh", "grep", "bash", "jq", "xargs"]);
  assertEquals(advisories.map((a) => a.entry), ["gh", "bash", "xargs"]);
  assertEquals(advisories.map((a) => a.hazard), ["net", "shell", "wrapper"]);
});
