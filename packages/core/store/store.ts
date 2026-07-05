import { DatabaseSync } from "node:sqlite";
import type { Message, Usage } from "../providers/types.ts";
import type { RunStatus } from "../loop/loop.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, seq)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES sessions(id),
  trigger TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL,
  reply TEXT NOT NULL,
  steps INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES runs(id),
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS identity (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

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

/** One audit event, as written to the audit table. */
export interface AuditRecord {
  /** Run the event belongs to, when known. */
  runId?: number;
  /** Event kind, e.g. "permission". */
  kind: string;
  /** Event payload; stored as JSON. */
  detail: unknown;
}

/**
 * The agent's canonical store: sessions, messages, runs, audit — one SQLite
 * file on a volume. This is the audit trail the platform later aggregates.
 */
export class Store {
  #db: DatabaseSync;

  /** Open (or create) the SQLite database at `path` and apply the schema. */
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(SCHEMA);
  }

  /** Close the underlying database. */
  close() {
    this.#db.close();
  }

  /** Get or create the session for a conversation key (e.g. a Discord thread id). */
  sessionFor(conversationKey: string): number {
    this.#db
      .prepare("INSERT OR IGNORE INTO sessions (conversation_key) VALUES (?)")
      .run(conversationKey);
    const row = this.#db
      .prepare("SELECT id FROM sessions WHERE conversation_key = ?")
      .get(conversationKey) as { id: number };
    return row.id;
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
      messages.forEach((m, seq) => ins.run(sessionId, seq, JSON.stringify(m)));
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Load a session's transcript in order. */
  loadMessages(sessionId: number): Message[] {
    const rows = this.#db
      .prepare("SELECT message_json FROM messages WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as { message_json: string }[];
    return rows.map((r) => JSON.parse(r.message_json));
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
        run.input,
        run.status,
        run.reply,
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
      .run(record.runId ?? null, record.kind, JSON.stringify(record.detail));
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
