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
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}
