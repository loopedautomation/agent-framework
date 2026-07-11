import { logInfo } from "@looped/core";
import { Cron } from "croner";
import type { AgentEvent, RunResult, Trigger } from "@looped/core";

/** Options for {@linkcode CronTrigger}. */
export interface CronTriggerOptions {
  /** Cron expression (croner syntax) that decides when the agent runs. */
  schedule: string;
  /** Prompt sent to the agent on every scheduled run. */
  prompt: string;
  /** Where results go — cron has no reply channel; default logs. */
  onResult?: (result: RunResult) => void;
}

/** Fires the agent on a cron schedule with a configured prompt. */
export class CronTrigger implements Trigger {
  /** Trigger name, used as the event's `trigger` field. */
  readonly name = "cron";
  #opts: CronTriggerOptions;
  #job?: Cron;
  // Per-instance serial lane: a schedule never overlaps itself, and two cron
  // triggers that happen to share an expression never block each other.
  #serialKey: string;

  /** Create the trigger; nothing is scheduled until {@linkcode start}. */
  constructor(opts: CronTriggerOptions) {
    this.#opts = opts;
    this.#serialKey = `cron:${opts.schedule}#${crypto.randomUUID().slice(0, 8)}`;
  }

  /** Schedule the cron job; each firing emits an event with the configured prompt. */
  start(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void> {
    this.#job = new Cron(this.#opts.schedule, async () => {
      // The serial lane holds one running firing and one waiting; a firing
      // past that resolves immediately with status "rejected" (audited),
      // because running a 6am summary three times at 6:07 helps nobody.
      const result = await emit({
        id: crypto.randomUUID(),
        trigger: this.name,
        input: this.#opts.prompt,
        serialKey: this.#serialKey,
      });
      (this.#opts.onResult ?? ((r: RunResult) => {
        logInfo(`cron run: ${r.status} — ${r.reply.slice(0, 200)}`);
      }))(result);
    });
    return Promise.resolve();
  }

  /** Cancel the cron job. */
  stop(): Promise<void> {
    this.#job?.stop();
    return Promise.resolve();
  }
}
