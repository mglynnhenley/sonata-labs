// Build the synthetic workspace into snapshot.db and copy it to working.db.
//
//   npm run seed
//
// Overwrites both DBs (snapshot is the pristine source of truth; working is
// what the sandbox serves). audit.db is left alone — the trail survives.

import Database from "better-sqlite3";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import {
  ensureDataDir,
  readSchema,
  SNAPSHOT_PATH,
  WORKING_PATH,
} from "../lib/db.js";
import { seedDatabase } from "../lib/seed.js";

function rmDbFiles(file: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
}

ensureDataDir();
console.log("Seeding synthetic workspace…");

rmDbFiles(SNAPSHOT_PATH);
const db = new Database(SNAPSHOT_PATH);
db.pragma("journal_mode = WAL");
db.exec(readSchema());
seedDatabase(db);

const counts = {
  users: (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n,
  conversations: (db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n,
  messages: (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n,
  reactions: (db.prepare("SELECT COUNT(*) AS n FROM reactions").get() as { n: number }).n,
};
// Checkpoint so the snapshot is a single self-contained file to copy.
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();

rmDbFiles(WORKING_PATH);
copyFileSync(SNAPSHOT_PATH, WORKING_PATH);
if (existsSync(SNAPSHOT_PATH + "-wal")) copyFileSync(SNAPSHOT_PATH + "-wal", WORKING_PATH + "-wal");

console.log(
  `  snapshot ${SNAPSHOT_PATH}\n  working  ${WORKING_PATH}\n` +
    `  ${counts.users} users, ${counts.conversations} conversations, ${counts.messages} messages, ${counts.reactions} reactions`,
);
console.log("Done.");
