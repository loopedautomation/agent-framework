import { z } from "zod";
import { defineTool, type NativeTool } from "./types.ts";

/** The trivial M1 native tool: proves the tool-use cycle with zero permissions. */
export const currentTimeTool: NativeTool = defineTool({
  name: "current_time",
  description: "Get the current date and time (UTC ISO 8601, plus the host timezone).",
  schema: z.strictObject({}),
  readOnly: true,
  execute() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return JSON.stringify({ utc: new Date().toISOString(), timezone: tz });
  },
});
