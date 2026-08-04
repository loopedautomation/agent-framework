import { DatabaseSync } from "node:sqlite";
import type { Message, Usage } from "../providers/types.ts";
import type { RunStatus } from "../loop/loop.ts";
import { migrate } from "./migrations.ts";
import type { Redactor } from "../redact/redact.ts";

/** One remembered fact, as written to the memories table. */
export interface MemoryRecord {
  /** The key the agent chose to file this fact under. */
  key: string;
  /** The fact itself. */
  value: string;
  /** ISO timestamp of first write. */
  createdAt: string;
  /** ISO timestamp of the most recent write. */
  updatedAt: string;
}

/**
 * Status as stored, which is wider than what a run can *end* with. `running`
 * is written when a run opens and replaced when it closes; `error_crashed` is
 * written by {@linkcode Store.recoverOpenRuns} for rows still open after a
 * restart. Neither is ever returned by `runAgent` — the loop's
 * {@linkcode RunStatus} stays honest about outcomes it can actually produce.
 */
export type StoredRunStatus = RunStatus | "running" | "error_crashed";

/** One completed run, as written to the runs table. */
export interface RunRecord {
  /** Session the run belonged to; absent for sessionless runs. */
  sessionId?: number;
  /** Which trigger produced the event, e.g. "cron" or "cli". */
  trigger: string;
  /** The input text the agent received. */
  input: string;
  /** How the run ended. */
  status: RunStatus;
  /** The agent's final reply. */
  reply: string;
  /** Inner-loop iterations consumed. */
  steps: number;
  /** Token usage for the whole run. */
  usage: Usage;
  /** ISO timestamp of when the run started. */
  startedAt: string;
}

/** What is known about a run at the moment it opens. */
export interface OpenRunRecord {
  /** Session the run belongs to; absent for sessionless runs. */
  sessionId?: number;
  /** Which trigger produced the event, e.g. "cron" or "cli". */
  trigger: string;
  /** The input text the agent received. */
  input: string;
  /** ISO timestamp of when the run started. */
  startedAt: string;
}

/** What is known once a run has ended. */
export interface RunOutcome {
  /** How the run ended. */
  status: RunStatus;
  /** The agent's final reply. */
  reply: string;
  /** Inner-loop iterations consumed. */
  steps: number;
  /** Token usage for the whole run. */
  usage: Usage;
  /** USD spent, when the model's price is known. Absent stores NULL: unpriced, not free. */
  cost?: number;
}

/** One agent-created schedule, as written to the schedules table. */
export interface ScheduleRecord {
  /** Row id; assigned on insert. */
  id: number;
  /** Cron expression for recurring schedules; undefined for one-shots. */
  cron?: string;
  /** ISO timestamp for one-shot schedules; undefined for recurring ones. */
  at?: string;
  /** IANA timezone the cron expression is evaluated in; undefined = local. */
  timezone?: string;
  /** The prompt the agent runs when the schedule fires. */
  prompt: string;
  /** Conversation the result delivers to; undefined logs like config cron. */
  conversationKey?: string;
}

/** One audit event, as written to the audit table. */
export interface AuditRecord {
  /** Run the event belongs to, when known. */
  runId?: number;
  /** Event kind, e.g. "permission". */
  kind: string;
  /** Event payload; stored as JSON. */
  detail: unknown;
}

/** Options for the {@linkcode Store} constructor. */
export interface StoreOptions {
  /**
   * Scrubs known secrets from everything written: transcripts, run inputs and
   * replies, audit detail. The tool results the model saw were already clean;
   * this is the boundary that keeps the file on disk clean too, whatever wrote
   * to it. Omitted, nothing is redacted.
   */
  redactor?: Redactor;
}

/**
 * The agent's canonical store: sessions, messages, runs, audit — one SQLite
 * file on a volume. This is the audit trail the platform later aggregates.
 */
export class Store {
  #db: DatabaseSync;
  #redactor?: Redactor;

  /** Open (or create) the SQLite database at `path` and apply pending migrations. */
  constructor(path: string, opts: StoreOptions = {}) {
    this.#redactor = opts.redactor;
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    // Parallel runs across conversations mean concurrent writers on one
    // file; wait for the lock instead of failing with SQLITE_BUSY.
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    migrate(this.#db);
  }

  /** Close the underlying database. */
  close() {
    this.#db.close();
  }

  /** Get or create the active session for a conversation key (e.g. a Discord channel id). */
  sessionFor(conversationKey: string): number {
    this.#db
      .prepare("INSERT OR IGNORE INTO sessions (conversation_key) VALUES (?)")
      .run(conversationKey);
    const row = this.#db
      .prepare("SELECT id FROM sessions WHERE conversation_key = ? AND archived_at IS NULL")
      .get(conversationKey) as { id: number };
    return row.id;
  }

  /**
   * Archive the active session for a key (the `/new` command): the history
   * stays queryable under the old session id, and the next message mints a
   * fresh session. Returns false when there is no active session with
   * messages — the conversation was already fresh.
   */
  archiveSession(conversationKey: string): boolean {
    const result = this.#db
      .prepare(
        `UPDATE sessions SET archived_at = datetime('now')
         WHERE conversation_key = ? AND archived_at IS NULL
           AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id)`,
      )
      .run(conversationKey);
    return result.changes > 0;
  }

  /** Scrub a value on its way to disk; identity when the store has no redactor. */
  #clean<T>(value: T): T {
    return this.#redactor ? this.#redactor.deep(value) : value;
  }

  /** Replace a session's transcript with the post-run message list. */
  saveMessages(sessionId: number, messages: Message[]) {
    const del = this.#db.prepare("DELETE FROM messages WHERE session_id = ?");
    const ins = this.#db.prepare(
      "INSERT INTO messages (session_id, seq, message_json) VALUES (?, ?, ?)",
    );
    this.#db.exec("BEGIN");
    try {
      del.run(sessionId);
      messages.forEach((m, seq) => ins.run(sessionId, seq, JSON.stringify(this.#clean(m))));
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Append messages to a session's transcript as a run produces them, so a
   * crash mid-run leaves the work that already happened on disk. Cheaper than
   * {@linkcode Store.saveMessages}, which rewrites the whole transcript: this
   * only inserts, continuing from the highest `seq` already stored.
   *
   * The final {@linkcode Store.saveMessages} at the end of a run is still the
   * authority. It replaces whatever these appends wrote with the run's final
   * message list, which is what makes the two safe to use together.
   */
  appendMessages(sessionId: number, messages: Message[]) {
    if (messages.length === 0) return;
    const row = this.#db
      .prepare("SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM messages WHERE session_id = ?")
      .get(sessionId) as { next: number };
    const ins = this.#db.prepare(
      "INSERT INTO messages (session_id, seq, message_json) VALUES (?, ?, ?)",
    );
    this.#db.exec("BEGIN");
    try {
      messages.forEach((m, i) => ins.run(sessionId, row.next + i, JSON.stringify(this.#clean(m))));
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Clear a conversation's transcript (the `/reset` command). Persistent
   * memories are untouched. Returns false when the key has no session or
   * the session was already empty.
   */
  clearSession(conversationKey: string): boolean {
    const row = this.#db
      .prepare("SELECT id FROM sessions WHERE conversation_key = ? AND archived_at IS NULL")
      .get(conversationKey) as { id: number } | undefined;
    if (!row) return false;
    const result = this.#db.prepare("DELETE FROM messages WHERE session_id = ?").run(row.id);
    return result.changes > 0;
  }

  /** Load a session's transcript in order. */
  loadMessages(sessionId: number): Message[] {
    const rows = this.#db
      .prepare("SELECT message_json FROM messages WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as { message_json: string }[];
    return rows.map((r) => JSON.parse(r.message_json));
  }

  /**
   * Lifetime run count, token totals and spend (the /status command). `cost`
   * sums only the runs whose model had a known price, so an agent on an
   * unpriced model reports 0 spend over 0 priced runs rather than claiming
   * its runs were free.
   */
  runStats(): {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    pricedRuns: number;
  } {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS runs,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost_usd), 0) AS cost,
                COUNT(cost_usd) AS priced_runs
         FROM runs`,
      )
      .get() as {
        runs: number;
        input_tokens: number;
        output_tokens: number;
        cost: number;
        priced_runs: number;
      };
    return {
      runs: row.runs,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cost: row.cost,
      pricedRuns: row.priced_runs,
    };
  }

  /**
   * Insert a run that has already ended; returns the new run id. For runs
   * that complete within one synchronous step (built-ins, queue refusals)
   * there is nothing to crash between opening and closing the row, so they
   * skip {@linkcode Store.openRun}.
   */
  recordRun(run: RunRecord): number {
    const result = this.#db
      .prepare(
        `INSERT INTO runs (session_id, trigger, input, status, reply, steps,
          input_tokens, output_tokens, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        run.sessionId ?? null,
        run.trigger,
        this.#clean(run.input),
        run.status,
        this.#clean(run.reply),
        run.steps,
        run.usage.inputTokens,
        run.usage.outputTokens,
        run.startedAt,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Open a run row before the work starts, so audit events have an id to hang
   * from and a run that dies mid-flight leaves a trace. The row carries
   * `status = 'running'` and a null `finished_at` until
   * {@linkcode Store.closeRun}.
   */
  openRun(run: OpenRunRecord): number {
    const result = this.#db
      .prepare(
        `INSERT INTO runs (session_id, trigger, input, status, reply, steps,
          input_tokens, output_tokens, started_at, finished_at)
         VALUES (?, ?, ?, 'running', '', 0, 0, 0, ?, NULL)`,
      )
      .run(run.sessionId ?? null, run.trigger, this.#clean(run.input), run.startedAt);
    return Number(result.lastInsertRowid);
  }

  /** Finalize a run opened by {@linkcode Store.openRun}. */
  closeRun(runId: number, outcome: RunOutcome) {
    this.#db
      .prepare(
        `UPDATE runs SET status = ?, reply = ?, steps = ?, input_tokens = ?,
           output_tokens = ?, cost_usd = ?, finished_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        outcome.status,
        this.#clean(outcome.reply),
        outcome.steps,
        outcome.usage.inputTokens,
        outcome.usage.outputTokens,
        outcome.cost ?? null,
        runId,
      );
  }

  /**
   * Close out runs left open by a previous process: a row still `running`
   * when the service starts is a run the container died in the middle of.
   * Returns how many were reconciled, so startup can say so.
   *
   * Only the service calls this, and only at startup. Doing it on every
   * {@linkcode Store} open would let a short-lived `af runs` mark the live
   * service's in-flight runs as crashed.
   */
  recoverOpenRuns(): number {
    const result = this.#db
      .prepare(
        `UPDATE runs SET status = 'error_crashed',
           reply = 'run did not finish: the agent stopped before this run completed',
           finished_at = datetime('now')
         WHERE finished_at IS NULL`,
      )
      .run();
    return Number(result.changes);
  }

  /** Insert an audit event. */
  recordAudit(record: AuditRecord) {
    this.#db
      .prepare("INSERT INTO audit (run_id, kind, detail_json) VALUES (?, ?, ?)")
      .run(record.runId ?? null, record.kind, JSON.stringify(this.#clean(record.detail)));
  }

  /** For `af runs` style introspection and tests. */
  recentRuns(limit = 20): Record<string, unknown>[] {
    return this.#db
      .prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
  }

  /** Most recent audit events, newest first. */
  recentAudit(limit = 50): Record<string, unknown>[] {
    return this.#db
      .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
  }

  /** Persist an agent-created schedule; returns its id. */
  createSchedule(schedule: Omit<ScheduleRecord, "id">): number {
    const result = this.#db
      .prepare(
        `INSERT INTO schedules (cron, at, timezone, prompt, conversation_key)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.cron ?? null,
        schedule.at ?? null,
        schedule.timezone ?? null,
        schedule.prompt,
        schedule.conversationKey ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  /** Every persisted schedule, oldest first. */
  listSchedules(): ScheduleRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT id, cron, at, timezone, prompt, conversation_key FROM schedules ORDER BY id",
      )
      .all() as {
        id: number;
        cron: string | null;
        at: string | null;
        timezone: string | null;
        prompt: string;
        conversation_key: string | null;
      }[];
    return rows.map((r) => ({
      id: r.id,
      cron: r.cron ?? undefined,
      at: r.at ?? undefined,
      timezone: r.timezone ?? undefined,
      prompt: r.prompt,
      conversationKey: r.conversation_key ?? undefined,
    }));
  }

  /** Remove a schedule; returns true if a row was deleted. */
  deleteSchedule(id: number): boolean {
    return this.#db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
  }

  /** How many schedules exist — checked against schedules.max. */
  countSchedules(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS c FROM schedules").get() as { c: number };
    return row.c;
  }

  /** The agent's self-chosen name and other identity facts (M3). */
  getIdentity(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM identity WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  /** Persist an identity fact, overwriting any previous value. */
  setIdentity(key: string, value: string) {
    this.#db
      .prepare(
        "INSERT INTO identity (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /**
   * Persist a memory, overwriting any previous value under the same key.
   * This is the agent's cross-conversation, cross-restart memory (M37) —
   * distinct from thread history, which lives in sessions/messages.
   */
  rememberMemory(key: string, value: string) {
    this.#db
      .prepare(
        `INSERT INTO memories (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(key, value);
  }

  /** Recall one memory by key. */
  recallMemory(key: string): MemoryRecord | undefined {
    const row = this.#db
      .prepare("SELECT key, value, created_at, updated_at FROM memories WHERE key = ?")
      .get(key) as
        | { key: string; value: string; created_at: string; updated_at: string }
        | undefined;
    if (!row) return undefined;
    return { key: row.key, value: row.value, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  /** All memories, most recently updated first. */
  listMemories(): MemoryRecord[] {
    const rows = this.#db
      .prepare("SELECT key, value, created_at, updated_at FROM memories ORDER BY updated_at DESC")
      .all() as { key: string; value: string; created_at: string; updated_at: string }[];
    return rows.map((r) => ({
      key: r.key,
      value: r.value,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** Delete a memory; returns true if a row was removed. */
  forgetMemory(key: string): boolean {
    const result = this.#db.prepare("DELETE FROM memories WHERE key = ?").run(key);
    return result.changes > 0;
  }

  /**
   * Claim a delivery id for a channel, for surfaces where the platform
   * delivers at-least-once. Returns true the first time an id is seen and
   * false for every repeat, so the caller can drop a retried webhook before
   * it becomes a second billed run. The insert is the claim: two concurrent
   * deliveries of the same id race on the primary key, and exactly one wins.
   */
  claimEvent(channel: string, eventId: string): boolean {
    const result = this.#db
      .prepare("INSERT OR IGNORE INTO seen_events (channel, event_id) VALUES (?, ?)")
      .run(channel, eventId);
    return result.changes > 0;
  }

  /**
   * Give a claim back, so the next copy of the same delivery is handled
   * instead of dropped. This is what a channel calls when the run behind a
   * claimed event failed: platforms that deliver at-least-once will send it
   * again, and a claim left behind turns one failure into permanent silence.
   */
  releaseEvent(channel: string, eventId: string): boolean {
    const result = this.#db
      .prepare("DELETE FROM seen_events WHERE channel = ? AND event_id = ?")
      .run(channel, eventId);
    return result.changes > 0;
  }

  /**
   * Drop claimed ids older than the platform's retry window; anything the
   * platform will never send again is not worth remembering.
   */
  pruneEvents(channel: string, olderThanDays: number): number {
    const result = this.#db
      .prepare(
        `DELETE FROM seen_events WHERE channel = ?
           AND seen_at < datetime('now', ?)`,
      )
      .run(channel, `-${olderThanDays} days`);
    return Number(result.changes);
  }

  /** Read a channel's durable per-key state (e.g. a WhatsApp service window). */
  getChannelState(channel: string, key: string): string | undefined {
    const row = this.#db
      .prepare("SELECT value FROM channel_state WHERE channel = ? AND key = ?")
      .get(channel, key) as { value: string } | undefined;
    return row?.value;
  }

  /**
   * Drop channel state untouched for longer than it can still mean anything.
   * These rows are keyed by whoever the channel was talking to, so on a public
   * endpoint the table otherwise grows by one row per stranger, forever.
   */
  pruneChannelState(channel: string, olderThanDays: number): number {
    const result = this.#db
      .prepare(
        `DELETE FROM channel_state WHERE channel = ?
           AND updated_at < datetime('now', ?)`,
      )
      .run(channel, `-${olderThanDays} days`);
    return Number(result.changes);
  }

  /** Write a channel's durable per-key state, overwriting any previous value. */
  setChannelState(channel: string, key: string, value: string) {
    this.#db
      .prepare(
        `INSERT INTO channel_state (channel, key, value) VALUES (?, ?, ?)
         ON CONFLICT(channel, key) DO UPDATE
           SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(channel, key, value);
  }
}
