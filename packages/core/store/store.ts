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

  /** Lifetime run count and token totals (the /status command). */
  runStats(): { runs: number; inputTokens: number; outputTokens: number } {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS runs,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM runs`,
      )
      .get() as { runs: number; input_tokens: number; output_tokens: number };
    return { runs: row.runs, inputTokens: row.input_tokens, outputTokens: row.output_tokens };
  }

  /** Insert a run record; returns the new run id. */
  recordRun(run: RunRecord): number {
    const result = this.#db
      .prepare(
        `INSERT INTO runs (session_id, trigger, input, status, reply, steps,
          input_tokens, output_tokens, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
}
