// Plan 13: conversations are the unit of order. Events sharing a lane run
// serially in arrival order; across lanes, runs are parallel up to a cap.
// Both rules live here, at the single choke point every trigger routes
// through, so no trigger carries its own concurrency behaviour.

/** Thrown by {@linkcode RunScheduler.submit} when a lane already holds its limit. */
export class QueueFullError extends Error {
  /** Events the lane held at rejection time: the running one plus everything waiting. */
  readonly held: number;

  /** Build the error; `lane` and `held` describe the full lane. */
  constructor(lane: string, held: number) {
    super(`lane ${lane} is full: ${held} events already running or waiting`);
    this.name = "QueueFullError";
    this.held = held;
  }
}

/** Options for {@linkcode RunScheduler}. */
export interface RunSchedulerOptions {
  /** Parallel runs across lanes (`limits.concurrent_runs`). */
  concurrentRuns: number;
  /** Default waiting events per lane before submissions are refused (`limits.queue_depth`). */
  queueDepth: number;
}

interface Lane {
  /** Settles when every accepted event has finished; new events chain onto it. */
  tail: Promise<void>;
  /** Events accepted and unfinished: the running one plus everything waiting. */
  held: number;
}

const NOOP = () => {};

/**
 * In-process run scheduler: a FIFO queue per lane and a semaphore across
 * lanes. A lane is a conversation key (or a trigger's serial key); events
 * without a lane take a semaphore slot directly. A queue is a place work
 * goes to hide, so every lane is bounded — past the depth, submissions are
 * refused with {@linkcode QueueFullError}.
 */
export class RunScheduler {
  #concurrent: number;
  #queueDepth: number;
  #running = 0;
  #queued = 0;
  #waiters: Array<() => void> = [];
  #lanes = new Map<string, Lane>();

  /** Create a scheduler with the given cap and default lane depth. */
  constructor(opts: RunSchedulerOptions) {
    this.#concurrent = opts.concurrentRuns;
    this.#queueDepth = opts.queueDepth;
  }

  /** Runs currently executing, across all lanes. */
  get running(): number {
    return this.#running;
  }

  /** Events accepted and waiting to start — behind a lane or a free slot. */
  get queued(): number {
    return this.#queued;
  }

  /**
   * Submit work. With a lane, the task runs after every earlier task on that
   * lane, in arrival order; without one, it runs as soon as a slot frees up.
   * Throws {@linkcode QueueFullError} when the lane already holds a running
   * task plus `queueDepth` waiting ones (override via `opts.queueDepth`).
   * The returned promise settles with the task's own outcome.
   */
  submit<T>(
    lane: string | undefined,
    task: () => Promise<T>,
    opts?: { queueDepth?: number },
  ): Promise<T> {
    if (lane === undefined) {
      this.#queued++;
      return this.#withSlot(task);
    }
    const depth = opts?.queueDepth ?? this.#queueDepth;
    const existing = this.#lanes.get(lane);
    if (existing && existing.held > depth) throw new QueueFullError(lane, existing.held);
    const entry = existing ?? { tail: Promise.resolve(), held: 0 };
    if (!existing) this.#lanes.set(lane, entry);
    entry.held++;
    this.#queued++;
    const result = entry.tail.then(() => this.#withSlot(task));
    entry.tail = result.then(NOOP, NOOP).then(() => {
      entry.held--;
      if (entry.held === 0 && this.#lanes.get(lane) === entry) this.#lanes.delete(lane);
    });
    return result;
  }

  async #withSlot<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    this.#queued--;
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#running < this.#concurrent) {
      this.#running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #release() {
    // Hand the slot to the oldest waiter; #running only drops when nobody waits.
    const next = this.#waiters.shift();
    if (next) next();
    else this.#running--;
  }
}
