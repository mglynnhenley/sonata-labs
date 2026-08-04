// Reset the working DB to the pristine snapshot.
//
//   npm run reset
//
// Prefers the in-process endpoint (the running server holds the SQLite handle).
// Falls back to a direct file copy if the server is down.

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { SNAPSHOT_PATH, WORKING_PATH } from "../lib/db.js";

const PORT = process.env.PORT || "3100";
const URL = `http://localhost:${PORT}/api/sandbox/reset`;

async function viaServer(): Promise<boolean> {
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "reset via CLI" }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { messages?: number };
    console.log(`Reset via server. Working DB now has ${data.messages ?? "?"} messages.`);
    return true;
  } catch {
    return false;
  }
}

function viaFileCopy(): void {
  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(`No snapshot at ${SNAPSHOT_PATH}. Run \`npm run seed\` or \`npm run sync\` first.`);
  }
  for (const s of ["", "-wal", "-shm"]) rmSync(WORKING_PATH + s, { force: true });
  copyFileSync(SNAPSHOT_PATH, WORKING_PATH);
  console.log("Reset via file copy (server was not running).");
}

if (!(await viaServer())) {
  viaFileCopy();
}
