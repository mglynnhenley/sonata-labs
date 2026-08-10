// Initialize the sandbox databases by applying db/schema.sql.
//
//   npm run db:init            # create snapshot.db + working.db + audit.db
//   npm run db:init -- --force # drop & recreate working.db from schema
//
// snapshot.db is created empty if missing (the sync CLI fills it). working.db
// is created from schema if missing. audit.db gets its two tables.

import Database from "better-sqlite3";
import { existsSync, rmSync } from "node:fs";
import {
  ensureDataDir,
  readSchema,
  SNAPSHOT_PATH,
  WORKING_PATH,
  AUDIT_PATH,
} from "../lib/db.js";
import { seedDevClients } from "../lib/oauth/clients.js";

const force = process.argv.includes("--force");
const schema = readSchema();

// snapshot.db + working.db carry the OAuth tables; seed the well-known dev
// clients into both so a `reset` (snapshot → working) preserves them. audit.db
// gets the schema too (harmless, IF NOT EXISTS) but never the clients.
function initFile(file: string, { drop, seedClients }: { drop?: boolean; seedClients?: boolean } = {}): void {
  if (drop && existsSync(file)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
    console.log(`  dropped ${file}`);
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(schema);
  if (seedClients) seedDevClients(db);
  db.close();
  console.log(`  ready   ${file}`);
}

ensureDataDir();
console.log("Initializing sandbox databases…");
initFile(SNAPSHOT_PATH, { seedClients: true });
initFile(WORKING_PATH, { drop: force, seedClients: true });
initFile(AUDIT_PATH);
console.log("Done.");
