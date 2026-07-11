import { z } from "zod";
import { dirname } from "@std/path";
import type { PermissionEngine } from "../permissions/engine.ts";
import { realPath } from "../permissions/paths.ts";
import { defineTool, type NativeTool } from "./types.ts";

const MAX_READ_CHARS = 8_000;

/**
 * Authorize the file the kernel will actually open, then open exactly that.
 * `..` has to normalize away before the prefix check or traversal walks
 * through it, and symlinks have to expand for the same reason: an allowed
 * path is otherwise free to point somewhere else entirely. The tools act on
 * the resolved path, so the check and the syscall agree on the destination.
 */
async function authorized(
  path: string,
  check: (real: string) => { allowed: boolean; reason?: string },
): Promise<{ real: string } | { denied: string }> {
  let real: string;
  try {
    real = await realPath(path);
  } catch (err) {
    // A path we can't resolve is a path we can't authorize.
    return { denied: `path error: ${(err as Error).message}` };
  }
  const decision = check(real);
  return decision.allowed ? { real } : { denied: decision.reason! };
}

/** Build the read_file native tool: reads allowlisted paths, truncating long files. */
export function createReadFileTool(permissions: PermissionEngine): NativeTool {
  return defineTool({
    name: "read_file",
    description: "Read a text file. Only paths in the agent's read allowlist are permitted.",
    schema: z.strictObject({ path: z.string().min(1) }),
    readOnly: true,
    async execute({ path }) {
      const result = await authorized(path, (real) => permissions.read(real));
      if ("denied" in result) return result.denied;
      try {
        const text = await Deno.readTextFile(result.real);
        return text.length > MAX_READ_CHARS
          ? text.slice(0, MAX_READ_CHARS) + `\n[truncated at ${MAX_READ_CHARS} chars]`
          : text;
      } catch (err) {
        return `read error: ${(err as Error).message}`;
      }
    },
  });
}

/** Build the write_file native tool: writes allowlisted paths, creating parent directories. */
export function createWriteFileTool(permissions: PermissionEngine): NativeTool {
  return defineTool({
    name: "write_file",
    description:
      "Write a text file (parent directories are created). Only paths in the agent's write allowlist are permitted.",
    schema: z.strictObject({ path: z.string().min(1), content: z.string() }),
    readOnly: false,
    async execute({ path, content }) {
      const result = await authorized(path, (real) => permissions.write(real));
      if ("denied" in result) return result.denied;
      try {
        // Missing parents are created inside the allowed root. They were
        // absent when the path resolved, so no symlink hides among them.
        const dir = dirname(result.real);
        if (dir !== result.real) await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(result.real, content);
        return `wrote ${content.length} chars to ${result.real}`;
      } catch (err) {
        return `write error: ${(err as Error).message}`;
      }
    },
  });
}
