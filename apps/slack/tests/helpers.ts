import { afterAll } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { seedDatabase } from "@/lib/seed";

const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");

/** Fresh in-memory DB with the schema applied. */
export function makeEmptyDb(): Database.Database {
  const db = trackDb(new Database(":memory:"));
  db.exec(schema);
  return db;
}

/** Fresh in-memory DB seeded with the full synthetic workspace. */
export function makeSeededDb(): Database.Database {
  const db = makeEmptyDb();
  seedDatabase(db);
  return db;
}

// Every SQLite handle a test opens is closed when its FILE ends.
//
// better-sqlite3 is a native addon: a handle left to the garbage collector is
// finalized during worker teardown, and if Node has already torn the
// environment down the destructor trips `Assertion failed: (env) != nullptr`
// and kills the worker. Every test passes and the run still exits 1, which is
// the worst possible way for this to present. Registering the hook here means a
// file gets the cleanup simply by importing the fixtures it was going to import
// anyway. It is afterAll and not afterEach because several suites open one
// database per file and share it across their cases.
const openHandles = new Set<Database.Database>();

/** Track a handle a test opened directly, so it is closed with the rest. */
export function trackDb<T extends Database.Database>(db: T): T {
  openHandles.add(db);
  return db;
}

afterAll(() => {
  for (const db of openHandles) {
    try {
      db.close();
    } catch {
      // Already closed by the test, or by a reset that swapped the file. Either
      // way there is nothing left to release.
    }
  }
  openHandles.clear();
});
