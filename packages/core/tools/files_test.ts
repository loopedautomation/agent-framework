import { assert, assertEquals } from "@std/assert";
import { PermissionEngine } from "../permissions/engine.ts";
import { createReadFileTool, createWriteFileTool } from "./files.ts";

Deno.test("read/write round-trip inside the allowlist; parents created", async () => {
  const dir = await Deno.makeTempDir();
  const engine = new PermissionEngine({ read: [dir], write: [dir] });
  const write = createWriteFileTool(engine);
  const read = createReadFileTool(engine);

  const result = await write.execute(
    JSON.stringify({ path: `${dir}/nested/notes.md`, content: "hello" }),
  );
  assert(result.startsWith("wrote 5 chars"));
  assertEquals(await read.execute(JSON.stringify({ path: `${dir}/nested/notes.md` })), "hello");
});

Deno.test("denials are readable tool results", async () => {
  const engine = new PermissionEngine({ read: ["/workspace"] });
  const read = createReadFileTool(engine);
  const write = createWriteFileTool(engine);

  const denied = await read.execute(JSON.stringify({ path: "/etc/hosts" }));
  assert(denied.includes("permission denied"));
  const writeDenied = await write.execute(JSON.stringify({ path: "/workspace/x", content: "" }));
  assert(writeDenied.includes("permissions.write")); // read grant ≠ write grant
});

Deno.test("traversal resolves before the prefix check", async () => {
  const dir = await Deno.makeTempDir();
  const engine = new PermissionEngine({ read: [dir] });
  const read = createReadFileTool(engine);
  const sneaky = await read.execute(JSON.stringify({ path: `${dir}/../../etc/passwd` }));
  assert(sneaky.includes("permission denied"), `traversal slipped through: ${sneaky}`);
});

Deno.test("missing files are readable errors, not crashes", async () => {
  const dir = await Deno.makeTempDir();
  const engine = new PermissionEngine({ read: [dir] });
  const read = createReadFileTool(engine);
  const result = await read.execute(JSON.stringify({ path: `${dir}/nope.txt` }));
  assert(result.startsWith("read error:"));
});

Deno.test("large reads truncate", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/big.txt`, "x".repeat(20_000));
  const engine = new PermissionEngine({ read: [dir] });
  const read = createReadFileTool(engine);
  const result = await read.execute(JSON.stringify({ path: `${dir}/big.txt` }));
  assert(result.includes("[truncated at 8000 chars]"));
});
