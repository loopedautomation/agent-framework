import { assert, assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { migrate, type Migration, MIGRATIONS } from "./migrations.ts";

function version(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function tables(db: DatabaseSync): string[] {
  return (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[]).map((r) => r.name);
}

Deno.test("a fresh database lands on the latest version", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  assertEquals(version(db), MIGRATIONS.length);
  assert(tables(db).includes("sessions"));
  db.close();
});

Deno.test("migrate is a no-op on an up-to-date database", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  migrate(db);
  assertEquals(version(db), MIGRATIONS.length);
  db.close();
});

Deno.test("pending migrations apply in order from the recorded version", () => {
  const applied: string[] = [];
  const list: Migration[] = [
    { id: "one", up: (db) => (applied.push("one"), db.exec("CREATE TABLE a (x)")) },
    { id: "two", up: (db) => (applied.push("two"), db.exec("CREATE TABLE b (x)")) },
  ];
  const db = new DatabaseSync(":memory:");
  migrate(db, list.slice(0, 1));
  assertEquals(version(db), 1);

  list.push({ id: "three", up: (db) => (applied.push("three"), db.exec("CREATE TABLE c (x)")) });
  migrate(db, list);
  assertEquals(applied, ["one", "two", "three"]);
  assertEquals(version(db), 3);
  assertEquals(tables(db), ["a", "b", "c"]);
  db.close();
});

Deno.test("a database created before versioning migrates cleanly", () => {
  // Pre-migration installs applied the schema directly, leaving
  // user_version at 0 with the tables already present.
  const db = new DatabaseSync(":memory:");
  MIGRATIONS[0].up(db);
  assertEquals(version(db), 0);
  db.exec("INSERT INTO identity (key, value) VALUES ('name', 'Ada')");

  migrate(db);
  assertEquals(version(db), MIGRATIONS.length);
  const row = db.prepare("SELECT value FROM identity WHERE key = 'name'").get() as {
    value: string;
  };
  assertEquals(row.value, "Ada");
  db.close();
});

Deno.test("a failed migration rolls back and keeps the version", () => {
  const list: Migration[] = [
    { id: "ok", up: (db) => db.exec("CREATE TABLE a (x)") },
    {
      id: "boom",
      up: (db) => {
        db.exec("CREATE TABLE b (x)");
        throw new Error("boom");
      },
    },
  ];
  const db = new DatabaseSync(":memory:");
  const err = assertThrows(() => migrate(db, list), Error, "migration boom failed");
  assertEquals((err.cause as Error).message, "boom");
  assertEquals(version(db), 1);
  assertEquals(tables(db), ["a"]);
  db.close();
});

Deno.test("002: a populated 001 database rebuilds sessions without losing anything", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, 1));
  db.exec(`
INSERT INTO sessions (conversation_key) VALUES ('discord:1'), ('discord:2');
INSERT INTO messages (session_id, seq, message_json) VALUES (1, 0, '{}'), (2, 0, '{}');
INSERT INTO runs (session_id, trigger, input, status, reply, steps,
  input_tokens, output_tokens, started_at)
  VALUES (2, 'cli', 'hi', 'ok', 'yo', 1, 10, 5, datetime('now'));
`);

  migrate(db);
  // Ids survived the rebuild, so messages and runs still point at their sessions.
  const keys = db
    .prepare("SELECT id, conversation_key, archived_at FROM sessions ORDER BY id")
    .all() as { id: number; conversation_key: string; archived_at: string | null }[];
  assertEquals(keys.map((r) => [r.id, r.conversation_key, r.archived_at]), [
    [1, "discord:1", null],
    [2, "discord:2", null],
  ]);
  assertEquals(db.prepare("PRAGMA foreign_key_check").all(), []);
  // Enforcement is back on after migrate() returns.
  assertEquals(
    (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
    1,
  );
  // Uniqueness now lives in the partial index: a second active row per key
  // is refused, but archiving frees the key up.
  const index = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_active_key'")
    .get();
  assert(index);
  db.close();
});

Deno.test("a database from a newer build is refused", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  assertThrows(() => migrate(db), Error, "newer version");
  db.close();
});

Deno.test("004 rebuilds runs without losing rows or their audit trail", () => {
  const db = new DatabaseSync(":memory:");
  // A database as it stood before open runs existed.
  migrate(db, MIGRATIONS.slice(0, 3));
  db.exec(`
INSERT INTO sessions (id, conversation_key) VALUES (1, 'k');
INSERT INTO runs (id, session_id, trigger, input, status, reply, steps,
                  input_tokens, output_tokens, started_at, finished_at)
  VALUES (1, 1, 'cron', 'old input', 'ok', 'old reply', 2, 30, 10,
          '2026-07-01T00:00:00Z', '2026-07-01T00:00:05Z');
INSERT INTO audit (run_id, kind, detail_json) VALUES (1, 'permission', '{"allowed":true}');
`);

  migrate(db);
  assertEquals(version(db), MIGRATIONS.length);

  const run = db.prepare("SELECT * FROM runs WHERE id = 1").get() as Record<string, unknown>;
  assertEquals(run.trigger, "cron");
  assertEquals(run.input, "old input");
  assertEquals(run.reply, "old reply");
  assertEquals(run.steps, 2);
  assertEquals(run.input_tokens, 30);
  assertEquals(run.started_at, "2026-07-01T00:00:00Z");
  assertEquals(run.finished_at, "2026-07-01T00:00:05Z");

  // The audit row still points at the rebuilt table.
  const audit = db.prepare("SELECT run_id FROM audit").get() as { run_id: number };
  assertEquals(audit.run_id, 1);
  assertEquals(db.prepare("PRAGMA foreign_key_check").all().length, 0);

  // And the column the rebuild existed for now accepts "not yet".
  db.exec(`
INSERT INTO runs (session_id, trigger, input, status, reply, steps,
                  input_tokens, output_tokens, started_at, finished_at)
  VALUES (1, 'cli', 'open', 'running', '', 0, 0, 0, '2026-08-01T00:00:00Z', NULL);
`);
  const open = db.prepare("SELECT finished_at FROM runs WHERE status = 'running'").get() as {
    finished_at: string | null;
  };
  assertEquals(open.finished_at, null);
  db.close();
});
