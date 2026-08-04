import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { seedDatabase } from "@/lib/seed";

const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");

/** Fresh in-memory DB with the schema applied. */
export function makeEmptyDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(schema);
  return db;
}

/** Fresh in-memory DB seeded with the full synthetic workspace. */
export function makeSeededDb(): Database.Database {
  const db = makeEmptyDb();
  seedDatabase(db);
  return db;
}
