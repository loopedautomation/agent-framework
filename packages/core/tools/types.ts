import { z } from "zod";
import type { ToolDef } from "../providers/types.ts";

/** A tool the framework can execute: a model-facing definition plus its implementation. */
export interface NativeTool {
  /** The definition presented to the model. */
  def: ToolDef;
  /** Takes the model's raw JSON argument string; returns the tool result. */
  execute(rawArgs: string): Promise<string>;
}

/**
 * The structural surface of a Zod schema that {@linkcode defineTool} relies
 * on. Documented as an interface so the public API stays free of Zod's
 * internal types; any Zod schema satisfies it.
 */
export interface ToolSchema<Args = unknown> {
  /** Validate unknown input; mirrors Zod's safeParse. */
  safeParse(data: unknown): { success: true; data: Args } | { success: false; error: Error };
}

/** The parsed argument type a tool schema produces. */
export type ToolArgs<S extends ToolSchema> = S extends ToolSchema<infer A> ? A : never;

/**
 * Define a tool from a Zod schema. Malformed or invalid arguments become a
 * readable tool *result* rather than a crash - the model gets the validation
 * error back and can self-repair (essential for cheap models).
 */
export function defineTool<S extends ToolSchema>(opts: {
  name: string;
  description: string;
  schema: S;
  readOnly?: boolean;
  execute(args: ToolArgs<S>): Promise<string> | string;
}): NativeTool {
  return {
    def: {
      name: opts.name,
      description: opts.description,
      inputSchema: z.toJSONSchema(opts.schema as unknown as z.ZodType, { io: "input" }) as Record<
        string,
        unknown
      >,
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
        return `invalid arguments: ${z.prettifyError(result.error as z.ZodError)}`;
      }
      try {
        return await opts.execute(result.data as ToolArgs<S>);
      } catch (err) {
        return `tool error: ${(err as Error).message}`;
      }
    },
  };
}
