import { assert, assertEquals } from "@std/assert";
import { PermissionEngine, permissionsToDenoFlags } from "./engine.ts";

Deno.test("deny by default: empty permissions deny everything", () => {
  const engine = new PermissionEngine(undefined);
  assertEquals(engine.net("api.github.com").allowed, false);
  assertEquals(engine.run("gh").allowed, false);
  assertEquals(engine.read("/tmp/x").allowed, false);
  assertEquals(engine.write("/tmp/x").allowed, false);
});

Deno.test("net: exact hosts and *. wildcards", () => {
  const engine = new PermissionEngine({ net: ["api.github.com", "*.example.com"] });
  assert(engine.net("api.github.com").allowed);
  assertEquals(engine.net("github.com").allowed, false);
  assert(engine.net("sub.example.com").allowed);
  assert(engine.net("a.b.example.com").allowed);
  assertEquals(engine.net("example.com").allowed, false); // wildcard excludes apex
  assertEquals(engine.net("evil-example.com").allowed, false);
});

Deno.test("run: basename matching", () => {
  const engine = new PermissionEngine({ run: ["gh"] });
  assert(engine.run("gh").allowed);
  assert(engine.run("/opt/homebrew/bin/gh").allowed);
  assertEquals(engine.run("git").allowed, false);
});

Deno.test("read/write: prefix matching without partial-segment leaks", () => {
  const engine = new PermissionEngine({ read: ["/workspace"], write: ["/workspace/out"] });
  assert(engine.read("/workspace").allowed);
  assert(engine.read("/workspace/notes.md").allowed);
  assertEquals(engine.read("/workspace-secrets/x").allowed, false);
  assert(engine.write("/workspace/out/report.txt").allowed);
  assertEquals(engine.write("/workspace/notes.md").allowed, false);
});

Deno.test("denials carry a reason and reach the audit sink", () => {
  const events: unknown[] = [];
  const engine = new PermissionEngine({ net: ["api.github.com"] }, (e) => events.push(e));
  const denied = engine.net("evil.com");
  assert(denied.reason?.includes("permissions.net"));
  engine.net("api.github.com");
  assertEquals(events.length, 2); // every decision audited, allowed or not
});

Deno.test("compiles to Deno flags", () => {
  const flags = permissionsToDenoFlags({
    net: ["api.github.com", "*.example.com"],
    run: ["gh"],
    read: ["/workspace"],
  });
  assertEquals(flags, [
    "--allow-net=api.github.com,example.com",
    "--allow-run=gh",
    "--allow-read=/workspace",
  ]);
  assertEquals(permissionsToDenoFlags(undefined), []);
});

Deno.test("relative path prefixes resolve against cwd", () => {
  const engine = new PermissionEngine({ write: ["agents"] });
  assert(engine.write(`${Deno.cwd()}/agents/new-bot/agent.yaml`).allowed);
  assertEquals(engine.write(`${Deno.cwd()}/elsewhere/x`).allowed, false);
});
