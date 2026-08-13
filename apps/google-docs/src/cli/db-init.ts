// Initialize the sandbox databases from the two schema files.
//
//   npm run db:init            # create snapshot.db + working.db + audit.db
//   npm run db:init -- --force # drop & recreate working.db from schema
//
// snapshot.db is created empty if missing (the seed CLI fills it). working.db is
// created from schema if missing. Both get db/schema.sql and audit.db gets
// db/audit-schema.sql — the split is the point: a document database that also
// carried `sessions` and `action_log` would shadow the real ones. Every
// statement in both is IF NOT EXISTS, so re-running is safe — which is the fix
// for the `no such table` 500s a fresh checkout produces, since data/*.db is
// gitignored and never arrives with the code.

import Database from "better-sqlite3";
import { existsSync, rmSync } from "node:fs";
import {
  ensureDataDir,
  readAuditSchema,
  readSchema,
  SNAPSHOT_PATH,
  WORKING_PATH,
  AUDIT_PATH,
} from "../lib/db.js";

const force = process.argv.includes("--force");
const schema = readSchema();
const auditSchema = readAuditSchema();

function initFile(file: string, ddl: string, { drop }: { drop?: boolean } = {}): void {
  if (drop && existsSync(file)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
    console.log(`  dropped ${file}`);
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(ddl);
  db.close();
  console.log(`  ready   ${file}`);
}

ensureDataDir();
console.log("Initializing sandbox databases…");
initFile(SNAPSHOT_PATH, schema);
initFile(WORKING_PATH, schema, { drop: force });
initFile(AUDIT_PATH, auditSchema);
console.log("Done.");
