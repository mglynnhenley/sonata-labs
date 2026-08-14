// Populate snapshot.db with the synthetic Acme page, then copy it to working.db.
// Lets the API be developed and demoed without a real LinkedIn account, which
// this clone could not use anyway — everything it serves is local.
//
//   npm run seed

import Database from "better-sqlite3";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { ensureDataDir, readSchema, SNAPSHOT_PATH, WORKING_PATH } from "../lib/db.js";
import { seedDatabase } from "../lib/seed.js";
import { countAll } from "../lib/store/counts.js";

const SUFFIXES = ["", "-wal", "-shm"];
function rmFiles(base: string): void {
  for (const s of SUFFIXES) rmSync(base + s, { force: true });
}

ensureDataDir();

console.log("Seeding snapshot.db with the Acme company page…");
rmFiles(SNAPSHOT_PATH);
const db = new Database(SNAPSHOT_PATH);
db.exec(readSchema());
seedDatabase(db);
const counts = countAll(db);
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();

console.log("Copying snapshot.db → working.db…");
rmFiles(WORKING_PATH);
copyFileSync(SNAPSHOT_PATH, WORKING_PATH);

console.log(
  `Done. ${counts.posts} posts, ${counts.comments} comments and ${counts.reactions} reactions ` +
    `across ${counts.members} members.`,
);
if (!existsSync(WORKING_PATH)) throw new Error("working.db was not created");
