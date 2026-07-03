import { z } from "zod";
import { resolve } from "@std/path";
import type { PermissionEngine } from "../permissions/engine.ts";
import { defineTool, type NativeTool } from "./types.ts";

const MAX_READ_CHARS = 8_000;

/**
 * Normalize before checking: `/workspace/../etc/passwd` must resolve to
 * `/etc/passwd` *before* it meets the prefix allowlist, or traversal walks
 * straight through it. Relative paths resolve against cwd (the container
 * workspace).
 */
function resolvePath(path: string): string {
  return resolve(path);
}

export function createReadFileTool(permissions: PermissionEngine): NativeTool {
  return defineTool({
    name: "read_file",
    description: "Read a text file. Only paths in the agent's read allowlist are permitted.",
    schema: z.strictObject({ path: z.string().min(1) }),
    readOnly: true,
    async execute({ path }) {
      const resolved = resolvePath(path);
      const decision = permissions.read(resolved);
      if (!decision.allowed) return decision.reason!;
      try {
        const text = await Deno.readTextFile(resolved);
        return text.length > MAX_READ_CHARS
          ? text.slice(0, MAX_READ_CHARS) + `\n[truncated at ${MAX_READ_CHARS} chars]`
          : text;
      } catch (err) {
        return `read error: ${(err as Error).message}`;
      }
    },
  });
}

export function createWriteFileTool(permissions: PermissionEngine): NativeTool {
  return defineTool({
    name: "write_file",
    description:
      "Write a text file (parent directories are created). Only paths in the agent's write allowlist are permitted.",
    schema: z.strictObject({ path: z.string().min(1), content: z.string() }),
    readOnly: false,
    async execute({ path, content }) {
      const resolved = resolvePath(path);
      const decision = permissions.write(resolved);
      if (!decision.allowed) return decision.reason!;
      try {
        const dir = resolved.slice(0, resolved.lastIndexOf("/"));
        if (dir) await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(resolved, content);
        return `wrote ${content.length} chars to ${resolved}`;
      } catch (err) {
        return `write error: ${(err as Error).message}`;
      }
    },
  });
}
