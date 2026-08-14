// Populate snapshot.db with the synthetic workspace, then copy it to working.db.
// Lets the API be developed and demoed without a real Google account.
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

console.log("Seeding snapshot.db with the synthetic workspace…");
rmFiles(SNAPSHOT_PATH);
const db = new Database(SNAPSHOT_PATH);
db.exec(readSchema());
seedDatabase(db);
const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const counts = {
  documents: count("documents"),
  paragraphs: count("paragraphs"),
  runs: count("text_runs"),
};
// Without the checkpoint the copy below misses the most recent writes, which are
// still sitting in the WAL sidecar.
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();

console.log("Copying snapshot.db → working.db…");
rmFiles(WORKING_PATH);
copyFileSync(SNAPSHOT_PATH, WORKING_PATH);

console.log(
  `Done. ${counts.documents} documents, ${counts.paragraphs} paragraphs, ${counts.runs} runs.`,
);
if (!existsSync(WORKING_PATH)) throw new Error("working.db was not created");
