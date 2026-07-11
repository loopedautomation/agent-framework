import { assert, assertEquals } from "@std/assert";
import { realPath, realPathSync } from "./paths.ts";

Deno.test("realPath: expands symlinks and normalizes traversal", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.mkdir(`${dir}/real`);
    await Deno.symlink(`${dir}/real`, `${dir}/link`);
    await Deno.writeTextFile(`${dir}/real/file.txt`, "x");

    assertEquals(await realPath(`${dir}/link/file.txt`), `${dir}/real/file.txt`);
    assertEquals(await realPath(`${dir}/real/../real/file.txt`), `${dir}/real/file.txt`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("realPath: a path that doesn't exist resolves through its deepest real ancestor", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.mkdir(`${dir}/real`);
    await Deno.symlink(`${dir}/real`, `${dir}/link`);

    // Nothing below `link` exists yet — write_file is allowed to create it,
    // and what it creates lands under the resolved ancestor.
    assertEquals(await realPath(`${dir}/link/a/b/new.txt`), `${dir}/real/a/b/new.txt`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("realPath: a wholly absent path keeps its lexical form", async () => {
  const resolved = await realPath("/no/such/place/at/all");
  assertEquals(resolved, "/no/such/place/at/all");
});

Deno.test("realPathSync: matches the async resolver, and survives an unresolvable prefix", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.mkdir(`${dir}/real`);
    await Deno.symlink(`${dir}/real`, `${dir}/link`);
    assertEquals(realPathSync(`${dir}/link`), `${dir}/real`);
    assertEquals(realPathSync(`${dir}/link/deep`), `${dir}/real/deep`);
    assertEquals(realPathSync("/no/such/root"), "/no/such/root");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("realPath: relative paths resolve against cwd", async () => {
  const resolved = await realPath("./deno.json");
  assert(resolved.startsWith("/"));
  assert(resolved.endsWith("/deno.json"));
});
