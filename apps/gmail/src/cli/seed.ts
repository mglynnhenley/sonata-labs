// Populate snapshot.db with a synthetic mailbox, then copy it to working.db —
// the same shape the real sync CLI produces. Lets the API/UI be developed and
// demoed without a real Gmail account.
//
//   npm run seed

import Database from "better-sqlite3";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { ensureDataDir, readSchema, SNAPSHOT_PATH, WORKING_PATH } from "../lib/db.js";
import { seedDatabase } from "../lib/seed.js";
import { seedDevClients } from "../lib/oauth/clients.js";

const SUFFIXES = ["", "-wal", "-shm"];
function rmFiles(base: string): void {
  for (const s of SUFFIXES) rmSync(base + s, { force: true });
}

ensureDataDir();

console.log("Seeding snapshot.db with a synthetic mailbox…");
rmFiles(SNAPSHOT_PATH);
const db = new Database(SNAPSHOT_PATH);
db.exec(readSchema());
seedDatabase(db);
// The bundled OAuth clients travel with the snapshot (and the copy to working.db)
// so the UI + smoke handshake work with no manual registration.
seedDevClients(db);
const counts = {
  messages: (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n,
  labels: (db.prepare("SELECT COUNT(*) AS n FROM labels").get() as { n: number }).n,
  threads: (
    db.prepare("SELECT COUNT(DISTINCT thread_id) AS n FROM messages").get() as { n: number }
  ).n,
};
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();

console.log("Copying snapshot.db → working.db…");
rmFiles(WORKING_PATH);
copyFileSync(SNAPSHOT_PATH, WORKING_PATH);

console.log(
  `Done. ${counts.messages} messages, ${counts.threads} threads, ${counts.labels} labels.`,
);
if (!existsSync(WORKING_PATH)) throw new Error("working.db was not created");
