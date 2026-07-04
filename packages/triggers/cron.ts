import { Cron } from "croner";
import type { AgentEvent, RunResult, Trigger } from "@looped/core";

export interface CronTriggerOptions {
  schedule: string;
  prompt: string;
  /** Where results go — cron has no reply channel; default logs. */
  onResult?: (result: RunResult) => void;
}

/** Fires the agent on a cron schedule with a configured prompt. */
export class CronTrigger implements Trigger {
  readonly name = "cron";
  #opts: CronTriggerOptions;
  #job?: Cron;

  constructor(opts: CronTriggerOptions) {
    this.#opts = opts;
  }

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

  stop(): Promise<void> {
    this.#job?.stop();
    return Promise.resolve();
  }
}
