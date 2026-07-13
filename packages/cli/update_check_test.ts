import { assert, assertEquals } from "@std/assert";
import { isNewerVersion, maybeNotifyUpdate, updateNotice } from "./update_check.ts";

function sink() {
  let text = "";
  return {
    stderr: {
      writeSync(data: Uint8Array) {
        text += new TextDecoder().decode(data);
        return data.length;
      },
    },
    text: () => text,
  };
}

function fetchLatest(version: string): typeof fetch {
  return ((_url, _init) =>
    Promise.resolve(
      new Response(JSON.stringify({ latest: version }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
}

const NO_CACHE = (() => Promise.reject(new Deno.errors.NotFound())) as typeof Deno.readTextFile;
const NOOP_MKDIR = (() => Promise.resolve()) as typeof Deno.mkdir;

Deno.test("updateCheck: semver comparison is numeric", () => {
  assert(isNewerVersion("0.10.0", "0.9.9"));
  assert(isNewerVersion("1.0.0", "0.99.99"));
  assert(!isNewerVersion("0.8.0", "0.8.0"));
  assert(!isNewerVersion("0.7.9", "0.8.0"));
  assert(!isNewerVersion("latest", "0.8.0"));
});

Deno.test("updateCheck: notice text is short and actionable", () => {
  assertEquals(
    updateNotice("0.9.0", "0.8.0"),
    "af 0.9.0 is available; you have 0.8.0. Run `af update`.\n",
  );
  assertEquals(updateNotice("0.8.0", "0.8.0"), undefined);
});

Deno.test("updateCheck: fresh cache prints without network", async () => {
  const out = sink();
  let fetched = false;
  await maybeNotifyUpdate({
    command: "ps",
    currentVersion: "0.8.0",
    now: () => 1_000,
    isTerminal: () => true,
    getEnv: () => undefined,
    cachePath: "/cache/af-update.json",
    readTextFile: (() =>
      Promise.resolve(
        JSON.stringify({ checkedAt: 999, latest: "0.9.0" }),
      )) as typeof Deno.readTextFile,
    fetch: ((_url, _init) => {
      fetched = true;
      return Promise.reject(new Error("should not fetch"));
    }) as typeof fetch,
    stderr: out.stderr,
  });

  assertEquals(fetched, false);
  assertEquals(out.text(), "af 0.9.0 is available; you have 0.8.0. Run `af update`.\n");
});

Deno.test("updateCheck: stale or missing cache fetches latest and writes cache", async () => {
  const out = sink();
  let written = "";
  await maybeNotifyUpdate({
    command: "run",
    currentVersion: "0.8.0",
    now: () => 2_000,
    isTerminal: () => true,
    getEnv: () => undefined,
    cachePath: "/cache/af-update.json",
    readTextFile: NO_CACHE,
    mkdir: NOOP_MKDIR,
    writeTextFile: ((_path, data) => {
      written = String(data);
      return Promise.resolve();
    }) as typeof Deno.writeTextFile,
    fetch: fetchLatest("0.9.0"),
    stderr: out.stderr,
  });

  assertEquals(JSON.parse(written), { checkedAt: 2_000, latest: "0.9.0" });
  assertEquals(out.text(), "af 0.9.0 is available; you have 0.8.0. Run `af update`.\n");
});

Deno.test("updateCheck: no notice when current is latest", async () => {
  const out = sink();
  await maybeNotifyUpdate({
    command: "validate",
    currentVersion: "0.8.0",
    isTerminal: () => true,
    getEnv: () => undefined,
    cachePath: "/cache/af-update.json",
    readTextFile: NO_CACHE,
    mkdir: NOOP_MKDIR,
    writeTextFile: (() => Promise.resolve()) as typeof Deno.writeTextFile,
    fetch: fetchLatest("0.8.0"),
    stderr: out.stderr,
  });

  assertEquals(out.text(), "");
});

Deno.test("updateCheck: skips non-interactive and explicit update runs", async () => {
  let fetched = 0;
  const fetchFn = ((_url, _init) => {
    fetched++;
    return Promise.resolve(new Response(JSON.stringify({ latest: "0.9.0" })));
  }) as typeof fetch;

  await maybeNotifyUpdate({
    command: "ps",
    isTerminal: () => false,
    getEnv: () => undefined,
    fetch: fetchFn,
  });
  await maybeNotifyUpdate({
    command: "update",
    isTerminal: () => true,
    getEnv: () => undefined,
    fetch: fetchFn,
  });
  await maybeNotifyUpdate({
    command: "ps",
    isTerminal: () => true,
    getEnv: (name) => (name === "CI" ? "1" : undefined),
    fetch: fetchFn,
  });

  assertEquals(fetched, 0);
});

Deno.test("updateCheck: failed network check is silent", async () => {
  const out = sink();
  await maybeNotifyUpdate({
    command: "ps",
    currentVersion: "0.8.0",
    isTerminal: () => true,
    getEnv: () => undefined,
    cachePath: "/cache/af-update.json",
    readTextFile: NO_CACHE,
    fetch: (() => Promise.reject(new Error("offline"))) as typeof fetch,
    stderr: out.stderr,
  });

  assertEquals(out.text(), "");
});

Deno.test("updateCheck: advisory failures never escape", async () => {
  const out = sink();
  await maybeNotifyUpdate({
    command: "ps",
    isTerminal: () => true,
    getEnv: () => {
      throw new Error("permission denied");
    },
    stderr: out.stderr,
  });

  assertEquals(out.text(), "");
});
