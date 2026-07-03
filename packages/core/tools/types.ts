import { z } from "zod";
import type { ToolDef } from "../providers/types.ts";

export interface NativeTool {
  def: ToolDef;
  /** Takes the model's raw JSON argument string; returns the tool result. */
  execute(rawArgs: string): Promise<string>;
}

/**
 * Define a tool from a Zod schema. Malformed or invalid arguments become a
 * readable tool *result* rather than a crash — the model gets the validation
 * error back and can self-repair (essential for cheap models).
 */
export function defineTool<S extends z.ZodType>(opts: {
  name: string;
  description: string;
  schema: S;
  readOnly?: boolean;
  execute(args: z.infer<S>): Promise<string> | string;
}): NativeTool {
  return {
    def: {
      name: opts.name,
      description: opts.description,
      inputSchema: z.toJSONSchema(opts.schema, { io: "input" }) as Record<string, unknown>,
      readOnly: opts.readOnly,
    },
    execute: async (rawArgs: string): Promise<string> => {
      let parsed: unknown;
      try {
        parsed = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
      } catch {
        return `invalid arguments: not valid JSON. Expected arguments matching the ${opts.name} schema.`;
      }
      const result = opts.schema.safeParse(parsed);
      if (!result.success) {
        return `invalid arguments: ${z.prettifyError(result.error)}`;
      }
      try {
        return await opts.execute(result.data);
      } catch (err) {
        return `tool error: ${(err as Error).message}`;
      }
    },
  };
}
