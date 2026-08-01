import type { DatabaseSync } from "node:sqlite";

/** One schema migration. Applied once, in order, inside a transaction. */
export interface Migration {
  /** Stable label used in error messages, e.g. "001_initial_schema". */
  id: string;
  /** Apply the migration. Runs inside a transaction the runner manages. */
  up(db: DatabaseSync): void;
}

/**
 * Every migration the store has ever shipped, in order. Append only: the
 * position in this array is the schema version recorded in the database
 * (`PRAGMA user_version`), so reordering or removing entries would make
 * existing databases misread their own history.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: "001_initial_schema",
    // IF NOT EXISTS is load-bearing here: databases created before schema
    // versioning existed have these tables but report user_version = 0, so
    // this migration replays against them and must be a no-op when it does.
    up(db) {
      db.exec(`
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
`);
    },
  },
  {
    id: "002_archivable_sessions",
    // /new archives the active session and lets the same conversation key
    // mint a fresh one, so uniqueness moves from the column to a partial
    // index over active sessions only. SQLite can't drop an inline UNIQUE,
    // hence the rebuild; the runner has foreign keys off while this runs.
    up(db) {
      db.exec(`
CREATE TABLE sessions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
INSERT INTO sessions_new (id, conversation_key, created_at)
  SELECT id, conversation_key, created_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE UNIQUE INDEX sessions_active_key
  ON sessions (conversation_key) WHERE archived_at IS NULL;
`);
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error("sessions rebuild left dangling references");
      }
    },
  },
  {
    id: "003_schedules",
    // Agent-created schedules (the schedule/unschedule tools): recurring
    // cron rows or one-shot `at` rows, surviving restarts. conversation_key
    // records where results deliver; a NULL key logs like config cron.
    up(db) {
      db.exec(`
CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cron TEXT,
  at TEXT,
  timezone TEXT,
  prompt TEXT NOT NULL,
  conversation_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((cron IS NULL) != (at IS NULL))
);
`);
    },
  },
  {
    id: "004_open_runs",
    // A run row is now written when the run starts rather than when it ends,
    // so `finished_at` has to be able to say "not yet". It was NOT NULL with a
    // datetime('now') default, which would stamp every open run at insert and
    // leave a crashed run indistinguishable from a clean one. SQLite cannot
    // drop NOT NULL in place, hence the rebuild; the runner has foreign keys
    // off while this runs and `audit.run_id` references this table.
    up(db) {
      db.exec(`
CREATE TABLE runs_new (
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
  finished_at TEXT
);
INSERT INTO runs_new (id, session_id, trigger, input, status, reply, steps,
                      input_tokens, output_tokens, started_at, finished_at)
  SELECT id, session_id, trigger, input, status, reply, steps,
         input_tokens, output_tokens, started_at, finished_at FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX runs_open ON runs (id) WHERE finished_at IS NULL;
`);
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error("runs rebuild left dangling references");
      }
    },
  },
];

/**
 * Bring `db` up to the latest schema. Reads the version from
 * `PRAGMA user_version`, applies each pending migration in its own
 * transaction and bumps the version alongside it, so a failed migration
 * rolls back completely and the next open retries from the same point.
 *
 * Throws if the database reports a version newer than this build knows,
 * rather than run against a schema shape it has never seen.
 */
export function migrate(db: DatabaseSync, migrations: Migration[] = MIGRATIONS) {
  const version = userVersion(db);
  if (version > migrations.length) {
    throw new Error(
      `database schema is at version ${version} but this build only knows ` +
        `${migrations.length}; it was likely written by a newer version of the framework`,
    );
  }
  // Table rebuilds (002's sessions rewrite) DROP and re-create tables that
  // other tables reference; that only works with enforcement off, and SQLite
  // requires the switch outside the transaction. Migrations that rebuild
  // check foreign_key_check themselves before committing.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (let i = version; i < migrations.length; i++) {
      const migration = migrations[i];
      db.exec("BEGIN");
      try {
        migration.up(db);
        db.exec(`PRAGMA user_version = ${i + 1}`);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw new Error(`migration ${migration.id} failed`, { cause: err });
      }
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}
