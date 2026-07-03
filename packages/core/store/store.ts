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
  cost_usd REAL,
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
`;

export interface RunRecord {
  sessionId?: number;
  trigger: string;
  input: string;
  status: RunStatus;
  reply: string;
  steps: number;
  usage: Usage;
  costUsd?: number;
  startedAt: string;
}

export interface AuditRecord {
  runId?: number;
  kind: string;
  detail: unknown;
}

/**
 * The agent's canonical store: sessions, messages, runs, audit — one SQLite
 * file on a volume. This is the audit trail the platform later aggregates.
 */
export class Store {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(SCHEMA);
  }

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

  loadMessages(sessionId: number): Message[] {
    const rows = this.#db
      .prepare("SELECT message_json FROM messages WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as { message_json: string }[];
    return rows.map((r) => JSON.parse(r.message_json));
  }

  recordRun(run: RunRecord): number {
    const result = this.#db
      .prepare(
        `INSERT INTO runs (session_id, trigger, input, status, reply, steps,
          input_tokens, output_tokens, cost_usd, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        run.costUsd ?? null,
        run.startedAt,
      );
    return Number(result.lastInsertRowid);
  }

  recordAudit(record: AuditRecord) {
    this.#db
      .prepare("INSERT INTO audit (run_id, kind, detail_json) VALUES (?, ?, ?)")
      .run(record.runId ?? null, record.kind, JSON.stringify(record.detail));
  }

  /** For `looped runs` style introspection and tests. */
  recentRuns(limit = 20): Record<string, unknown>[] {
    return this.#db
      .prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
  }

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

  setIdentity(key: string, value: string) {
    this.#db
      .prepare(
        "INSERT INTO identity (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }
}
