import { z } from "zod";
import { Cron } from "croner";
import type { ScheduleRecord, Store } from "../store/store.ts";
import { defineTool, type NativeTool } from "./types.ts";

// The schedule/list_schedules/unschedule tools (config: `schedules:`).
// The agent files future work for itself: a recurring cron row or a one-shot
// timestamp, persisted in its own SQLite file so restarts change nothing.
// The service owns actually firing them; these tools own the rows.

/** A schedule create or cancel, for the audit trail and the live runner. */
export type ScheduleEvent =
  | { action: "create"; schedule: ScheduleRecord }
  | { action: "cancel"; schedule: ScheduleRecord };

/**
 * System-prompt note when the tools are enabled, so the model knows the
 * capability exists before anyone asks for a reminder.
 */
export function schedulesPromptSection(count: number, max: number): string {
  return `\n\nYou can schedule future runs of yourself: use the schedule tool with a cron ` +
    `expression for recurring work or an ISO timestamp for one-offs (reminders), ` +
    `list_schedules to review, unschedule to cancel. The prompt you schedule is what you will ` +
    `be asked when it fires, so write it to your future self with full context. ` +
    `Schedules held: ${count} of ${max}.`;
}

/** Refuse second-granularity patterns: the finest schedule is one minute. */
function validateCron(pattern: string, timezone?: string): { error?: string; next?: Date } {
  if (pattern.trim().split(/\s+/).length > 5) {
    return { error: "second-level patterns are refused; the finest granularity is one minute" };
  }
  try {
    const probe = new Cron(pattern, { paused: true, timezone });
    const next = probe.nextRun() ?? undefined;
    probe.stop();
    if (!next) return { error: "this pattern never fires" };
    return { next };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Render one schedule as a line for tool results. */
function describe(s: ScheduleRecord): string {
  const when = s.cron
    ? `cron "${s.cron}"${s.timezone ? ` (${s.timezone})` : ""}`
    : `once at ${s.at}`;
  const where = s.conversationKey ? ` -> ${s.conversationKey}` : "";
  return `#${s.id} ${when}${where}: ${s.prompt}`;
}

/**
 * Build the schedule tools over an agent's own store. `conversationKey` is
 * the conversation the current event came from — new schedules deliver
 * their results there. `onEvent` fires on create/cancel so the service can
 * register the job live and land an audit row.
 */
export function createScheduleTools(opts: {
  store: Store;
  max: number;
  conversationKey?: string;
  onEvent?: (event: ScheduleEvent) => void;
}): NativeTool[] {
  const { store, max } = opts;

  const schedule = defineTool({
    name: "schedule",
    description:
      "Schedule a future run of yourself. Give `cron` (five-field expression, optionally with " +
      "`timezone`) for recurring work, or `at` (ISO 8601 timestamp) for a one-shot like a " +
      "reminder. `prompt` is what you will be asked when it fires — write it with full " +
      "context, including who asked and what to do. The result is delivered to this " +
      "conversation.",
    schema: z.strictObject({
      prompt: z.string().min(1),
      cron: z.string().min(1).optional(),
      at: z.string().min(1).optional(),
      timezone: z.string().min(1).optional(),
    }),
    readOnly: false,
    execute({ prompt, cron, at, timezone }) {
      if ((cron === undefined) === (at === undefined)) {
        return "give exactly one of `cron` (recurring) or `at` (one-shot)";
      }
      if (store.countSchedules() >= max) {
        return `schedule limit reached (${max}). List with list_schedules and unschedule ` +
          "something first.";
      }
      let firstRun: Date;
      if (cron !== undefined) {
        const { error, next } = validateCron(cron, timezone);
        if (error) return `invalid cron pattern: ${error}`;
        firstRun = next!;
      } else {
        const when = new Date(at!);
        if (Number.isNaN(when.getTime())) return `not an ISO 8601 timestamp: ${at}`;
        if (when.getTime() <= Date.now()) return `${at} is in the past`;
        firstRun = when;
      }
      const record: Omit<ScheduleRecord, "id"> = {
        cron,
        at,
        timezone: cron !== undefined ? timezone : undefined,
        prompt,
        conversationKey: opts.conversationKey,
      };
      const id = store.createSchedule(record);
      opts.onEvent?.({ action: "create", schedule: { id, ...record } });
      return `scheduled #${id} — ${
        cron !== undefined ? "next" : "fires"
      } ${firstRun.toISOString()}`;
    },
  });

  const listSchedules = defineTool({
    name: "list_schedules",
    description: "List every schedule currently held, with ids for unschedule.",
    schema: z.strictObject({}),
    readOnly: true,
    execute() {
      const schedules = store.listSchedules();
      if (!schedules.length) return "no schedules held";
      return schedules.map(describe).join("\n");
    },
  });

  const unschedule = defineTool({
    name: "unschedule",
    description: "Cancel a schedule by its id (see list_schedules).",
    schema: z.strictObject({ id: z.number().int().positive() }),
    readOnly: false,
    execute({ id }) {
      const existing = store.listSchedules().find((s) => s.id === id);
      if (!existing || !store.deleteSchedule(id)) return `no schedule #${id}`;
      opts.onEvent?.({ action: "cancel", schedule: existing });
      return `unscheduled #${id}`;
    },
  });

  return [schedule, listSchedules, unschedule];
}
