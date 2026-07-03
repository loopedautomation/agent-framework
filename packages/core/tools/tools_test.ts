import { assert, assertEquals } from "@std/assert";
import { PermissionEngine } from "../permissions/engine.ts";
import { resolveEnv } from "../config/env.ts";
import { ConfigError } from "../config/load.ts";
import { createRunBashTool, extractExecutables } from "./bash.ts";
import { createHttpRequestTool } from "./http.ts";

Deno.test("extractExecutables: pipes, chains, env prefixes, and rejections", () => {
  const multi = extractExecutables("FOO=1 gh issue list | grep bug && echo done");
  assert(multi.ok);
  assertEquals(multi.executables, ["gh", "grep", "echo"]);

  assertEquals(extractExecutables("echo $(whoami)").ok, false);
  assertEquals(extractExecutables("echo `whoami`").ok, false);
  assertEquals(extractExecutables("   ").ok, false);
});

Deno.test("run_bash: permitted command runs with a scoped environment only", async () => {
  const tool = createRunBashTool({
    permissions: new PermissionEngine({ run: ["bash", "env"] }),
    env: { GRANTED: "yes" },
  });
  Deno.env.set("AMBIENT_SECRET", "leak-me");
  try {
    const result = JSON.parse(await tool.execute(JSON.stringify({ command: "env" })));
    assertEquals(result.exit_code, 0);
    assert(result.stdout.includes("GRANTED=yes"));
    assert(!result.stdout.includes("AMBIENT_SECRET"), "ambient env must not leak to subprocesses");
  } finally {
    Deno.env.delete("AMBIENT_SECRET");
  }
});

Deno.test("run_bash: denied executable returns the denial as a tool result", async () => {
  const tool = createRunBashTool({
    permissions: new PermissionEngine({ run: ["echo"] }),
    env: {},
  });
  const result = await tool.execute(JSON.stringify({ command: "echo hi && curl evil.com" }));
  assert(result.includes("permission denied"));
  assert(result.includes("curl"));
});

Deno.test("http_request: allowed host passes, denied host returns denial", async () => {
  const fakeFetch = (() =>
    Promise.resolve(
      new Response("pong", { status: 200, headers: { "content-type": "text/plain" } }),
    )) as typeof fetch;
  const tool = createHttpRequestTool({
    permissions: new PermissionEngine({ net: ["api.github.com"] }),
    fetch: fakeFetch,
  });

  const ok = JSON.parse(
    await tool.execute(JSON.stringify({ url: "https://api.github.com/zen" })),
  );
  assertEquals(ok.status, 200);
  assertEquals(ok.body, "pong");

  const denied = await tool.execute(JSON.stringify({ url: "https://evil.com/x" }));
  assert(denied.includes("permission denied"));
});

Deno.test("resolveEnv: literals pass, refs resolve, secrets dir is a fallback", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/FROM_FILE`, "file-secret\n");
  const resolved = resolveEnv(
    { A: "literal", B: "${FROM_ENV}", C: "${FROM_FILE}" },
    { getEnv: (n) => (n === "FROM_ENV" ? "env-secret" : undefined), secretsDir: dir },
  );
  assertEquals(resolved, { A: "literal", B: "env-secret", C: "file-secret" });
});

Deno.test("resolveEnv: missing reference fails at startup with a clear error", () => {
  let err: unknown;
  try {
    resolveEnv({ TOKEN: "${MISSING}" }, { getEnv: () => undefined, secretsDir: "/nonexistent" });
  } catch (e) {
    err = e;
  }
  assert(err instanceof ConfigError);
  assert(err.message.includes("MISSING"));
});
