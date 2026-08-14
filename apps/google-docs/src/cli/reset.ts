// Reset the working DB to the pristine snapshot.
//
//   npm run reset
//
// Prefers the in-process endpoint (the running server holds the SQLite handle).
// Falls back to a direct file copy if the server is down.

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { SNAPSHOT_PATH, WORKING_PATH } from "../lib/db.js";

// This clone's REAL port. The Gmail twin's CLI default drifted to 3100 while the
// twin runs on 3101, and a wrong PORT does not fail loudly — it resets a
// different server and reports success.
const PORT = process.env.PORT || "3600";
const TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";
const URL = `http://localhost:${PORT}/api/sandbox/reset`;

async function viaServer(): Promise<boolean> {
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sandbox-token": TOKEN },
      body: JSON.stringify({ note: "reset via CLI" }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { documents?: number };
    console.log(`Reset via server. Working DB now has ${data.documents ?? "?"} documents.`);
    return true;
  } catch {
    return false;
  }
}

function viaFileCopy(): void {
  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(`No snapshot at ${SNAPSHOT_PATH}. Run \`npm run seed\` first.`);
  }
  for (const s of ["", "-wal", "-shm"]) rmSync(WORKING_PATH + s, { force: true });
  copyFileSync(SNAPSHOT_PATH, WORKING_PATH);
  console.log("Reset via file copy (server was not running).");
}

if (!(await viaServer())) {
  viaFileCopy();
}
