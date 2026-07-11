import { basename, dirname, join, resolve } from "@std/path";

// Authorizing a path means authorizing the file the kernel will actually
// open. Lexical normalization alone doesn't get there: a symlink inside an
// allowed directory points wherever it likes, so `/workspace/link/secret`
// reads `/etc/secret` while looking like it never left `/workspace`. Every
// path crossing the permission boundary is expanded through its symlinks
// first, on both sides of the comparison.

/**
 * The absolute path with every symlink expanded — what the filesystem will
 * act on. A path that doesn't exist yet resolves through its deepest existing
 * ancestor: the components below that ancestor are not on disk, so they can't
 * be symlinks, and `write_file` still gets to create them.
 *
 * Errors other than a missing path (a permission error from the sandbox, say)
 * propagate: a path we can't resolve is a path we can't authorize.
 */
export async function realPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await Deno.realPath(current);
      return missing.length > 0 ? join(real, ...missing.reverse()) : real;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
      const parent = dirname(current);
      // The root itself is missing (or we walked past it): nothing left to
      // expand, so the lexical path is as resolved as it gets.
      if (parent === current) return absolute;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * {@linkcode realPath}, synchronously, for the allowlist prefixes the engine
 * compares against. A prefix that can't be resolved (it doesn't exist yet, or
 * the sandbox won't let us look) falls back to its lexical form: an
 * unresolvable root can't be escaped through a symlink it doesn't have.
 */
export function realPathSync(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = Deno.realPathSync(current);
      return missing.length > 0 ? join(real, ...missing.reverse()) : real;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) return absolute;
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.push(basename(current));
      current = parent;
    }
  }
}
