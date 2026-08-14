// Populate snapshot.db with a synthetic CRM, then copy it to working.db. Lets
// the API be developed and demoed without a real Attio workspace.
//
//   npm run seed

import Database from "better-sqlite3";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { ensureDataDir, readSchema, SNAPSHOT_PATH, WORKING_PATH } from "../lib/db.js";
import { seedDatabase } from "../lib/seed.js";

const SUFFIXES = ["", "-wal", "-shm"];
function rmFiles(base: string): void {
  for (const s of SUFFIXES) rmSync(base + s, { force: true });
}

ensureDataDir();

console.log("Seeding snapshot.db with a synthetic CRM…");
rmFiles(SNAPSHOT_PATH);
const db = new Database(SNAPSHOT_PATH);
db.exec(readSchema());
seedDatabase(db);
const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const counts = {
  objects: count("objects"),
  records: count("records"),
  values: count("attribute_values"),
  notes: count("notes"),
  tasks: count("tasks"),
};
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();

console.log("Copying snapshot.db → working.db…");
rmFiles(WORKING_PATH);
copyFileSync(SNAPSHOT_PATH, WORKING_PATH);

console.log(
  `Done. ${counts.records} records across ${counts.objects} objects ` +
    `(${counts.values} values), ${counts.notes} notes, ${counts.tasks} tasks.`,
);
if (!existsSync(WORKING_PATH)) throw new Error("working.db was not created");
