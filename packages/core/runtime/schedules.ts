import { Cron } from "croner";
import type { ScheduleRecord } from "../store/store.ts";

// The live half of agent-created schedules: croner jobs keyed by row id.
// The store is the source of truth and the service owns firing semantics;
// this class only turns rows into timers and timers back off.

/** Runs agent-created schedules; one croner job per persisted row. */
export class ScheduleRunner {
  #jobs = new Map<number, Cron>();
  #onFire: (schedule: ScheduleRecord) => void;

  /** `onFire` must not throw — the service wraps its own error handling. */
  constructor(onFire: (schedule: ScheduleRecord) => void) {
    this.#onFire = onFire;
  }

  /** Register a schedule. A past-due one-shot is the caller's problem. */
  add(schedule: ScheduleRecord) {
    this.remove(schedule.id);
    const fire = () => this.#onFire(schedule);
    if (schedule.cron !== undefined) {
      this.#jobs.set(
        schedule.id,
        new Cron(schedule.cron, { timezone: schedule.timezone }, fire),
      );
    } else if (schedule.at !== undefined) {
      const when = new Date(schedule.at);
      if (when.getTime() > Date.now()) {
        this.#jobs.set(schedule.id, new Cron(when, { maxRuns: 1 }, fire));
      }
    }
  }

  /** Stop and forget one schedule's job. */
  remove(id: number) {
    this.#jobs.get(id)?.stop();
    this.#jobs.delete(id);
  }

  /** Jobs currently armed. */
  get size(): number {
    return this.#jobs.size;
  }

  /** Stop everything (service shutdown). */
  stop() {
    for (const job of this.#jobs.values()) job.stop();
    this.#jobs.clear();
  }
}
