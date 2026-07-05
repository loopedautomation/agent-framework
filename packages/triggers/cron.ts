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

  /** Create the trigger; nothing is scheduled until {@linkcode start}. */
  constructor(opts: CronTriggerOptions) {
    this.#opts = opts;
  }

  /** Schedule the cron job; each firing emits an event with the configured prompt. */
  start(emit: (event: AgentEvent) => Promise<RunResult>): Promise<void> {
    this.#job = new Cron(this.#opts.schedule, async () => {
      const result = await emit({
        id: crypto.randomUUID(),
        trigger: this.name,
        input: this.#opts.prompt,
      });
      (this.#opts.onResult ?? ((r: RunResult) => {
        console.log(`cron run: ${r.status} — ${r.reply.slice(0, 200)}`);
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
