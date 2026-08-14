import { copyFileSync, existsSync, rmSync } from "node:fs";
import { getDb, closeWorkingDb, SNAPSHOT_PATH, WORKING_PATH } from "./db";
import { startNewSession } from "./audit";
import { countAll, type CloneCounts } from "./store/counts";

const SUFFIXES = ["", "-wal", "-shm"];

function rmFiles(base: string): void {
  for (const s of SUFFIXES) rmSync(base + s, { force: true });
}

/**
 * Reset the working DB to the pristine snapshot. Must run in-process because
 * the server holds the working SQLite handle: close it → delete working.db* →
 * copy snapshot → reopen. Starts a fresh audit session (audit.db is untouched,
 * so the trail survives).
 */
export function resetWorking(note = "reset to snapshot"): CloneCounts {
  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(`snapshot not found at ${SNAPSHOT_PATH} — run \`npm run seed\` first`);
  }
  closeWorkingDb();
  rmFiles(WORKING_PATH);
  copyFileSync(SNAPSHOT_PATH, WORKING_PATH);
  // Copy any sidecar files that exist (should be none if the snapshot was
  // checkpointed, but be defensive — a half-old WAL restores a half-old world).
  for (const s of ["-wal", "-shm"]) {
    if (existsSync(SNAPSHOT_PATH + s)) copyFileSync(SNAPSHOT_PATH + s, WORKING_PATH + s);
  }
  const db = getDb();
  startNewSession(db, note);
  return countAll(db);
}

/**
 * Promote the current working DB to the pristine snapshot — how a generated
 * business becomes the baseline every later run resets back to. Checkpoints the
 * WAL first, because without it the copied file is missing the most recent
 * writes. Nothing may hold the `db` reference across this call: it closes and
 * reopens the handle every route shares.
 */
export function snapshotWorking(): CloneCounts {
  const db = getDb();
  const counts = countAll(db);
  db.pragma("wal_checkpoint(TRUNCATE)");
  closeWorkingDb();
  rmFiles(SNAPSHOT_PATH);
  copyFileSync(WORKING_PATH, SNAPSHOT_PATH);
  getDb();
  return counts;
}
