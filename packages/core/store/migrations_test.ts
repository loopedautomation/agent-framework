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

Deno.test("a database from a newer build is refused", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  assertThrows(() => migrate(db), Error, "newer version");
  db.close();
});
