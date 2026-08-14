// Reset the working DB to the pristine snapshot.
//
//   npm run reset
//
// Prefers the in-process endpoint (the running server holds the SQLite handle).
// Falls back to a direct file copy if the server is down.

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { SNAPSHOT_PATH, WORKING_PATH } from "../lib/db.js";

// This clone's REAL port, not a placeholder. A wrong PORT does not fail loudly:
// reset will happily reset a different server and report success.
const PORT = process.env.PORT || "3800";
const TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";
// 127.0.0.1, not localhost: Node's fetch tries ::1 first and the Next dev server
// listens on IPv4 only, so `localhost` here silently falls through to the file
// copy while the server that owns the handle is sitting right there.
const URL = `http://127.0.0.1:${PORT}/api/sandbox/reset`;

async function viaServer(): Promise<boolean> {
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sandbox-token": TOKEN },
      body: JSON.stringify({ note: "reset via CLI" }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { posts?: number };
    console.log(`Reset via server. Working DB now has ${data.posts ?? "?"} posts.`);
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
