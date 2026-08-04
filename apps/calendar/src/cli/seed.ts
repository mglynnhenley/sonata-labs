// Populate snapshot.db with a synthetic calendar, then copy it to working.db.
// Lets the API/UI be developed and demoed without a real Google account.
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

console.log("Seeding snapshot.db with a synthetic calendar…");
rmFiles(SNAPSHOT_PATH);
const db = new Database(SNAPSHOT_PATH);
db.exec(readSchema());
seedDatabase(db);
const counts = {
  calendars: (db.prepare("SELECT COUNT(*) AS n FROM calendars").get() as { n: number }).n,
  events: (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
  attendees: (
    db.prepare("SELECT COUNT(*) AS n FROM event_attendees").get() as { n: number }
  ).n,
};
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();

console.log("Copying snapshot.db → working.db…");
rmFiles(WORKING_PATH);
copyFileSync(SNAPSHOT_PATH, WORKING_PATH);

console.log(
  `Done. ${counts.events} events across ${counts.calendars} calendars, ${counts.attendees} attendees.`,
);
if (!existsSync(WORKING_PATH)) throw new Error("working.db was not created");
