import { copyFileSync, existsSync, rmSync } from "node:fs";
import { getDb, closeWorkingDb, SNAPSHOT_PATH, WORKING_PATH } from "./db";
import { startNewSession } from "./audit";
import { countMessages } from "./store/messages";

const SUFFIXES = ["", "-wal", "-shm"];

function rmWorkingFiles(): void {
  for (const s of SUFFIXES) rmSync(WORKING_PATH + s, { force: true });
}

/**
 * Reset the working DB to the pristine snapshot. Must run in-process because
 * the server holds the working SQLite handle: close it → delete working.db* →
 * copy snapshot → reopen. Starts a fresh audit session (audit.db is a separate
 * file, so the trail survives).
 */
export function resetWorking(note = "reset to snapshot"): { messages: number } {
  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(`snapshot not found at ${SNAPSHOT_PATH} — run \`npm run seed\` first`);
  }
  closeWorkingDb();
  rmWorkingFiles();
  copyFileSync(SNAPSHOT_PATH, WORKING_PATH);
  // Copy any sidecar files that exist (should be none if the snapshot was
  // checkpointed, but be defensive).
  for (const s of ["-wal", "-shm"]) {
    if (existsSync(SNAPSHOT_PATH + s)) copyFileSync(SNAPSHOT_PATH + s, WORKING_PATH + s);
  }
  const db = getDb();
  startNewSession(db, note);
  return { messages: countMessages(db) };
}
