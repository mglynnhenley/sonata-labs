import { copyFileSync, existsSync, rmSync } from "node:fs";
import { getDb, closeWorkingDb, SNAPSHOT_PATH, WORKING_PATH } from "./db";
import { startNewSession } from "./audit";
import { countEvents } from "./store/events";
import { countCalendars } from "./store/calendars";

const SUFFIXES = ["", "-wal", "-shm"];

function rmFiles(base: string): void {
  for (const s of SUFFIXES) rmSync(base + s, { force: true });
}

export interface ResetResult {
  events: number;
  calendars: number;
}

/**
 * Reset the working DB to the pristine snapshot. Must run in-process because
 * the server holds the working SQLite handle: close it → delete working.db* →
 * copy snapshot → reopen. Starts a fresh audit session (audit.db is untouched,
 * so the trail survives).
 */
export function resetWorking(note = "reset to snapshot"): ResetResult {
  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(`snapshot not found at ${SNAPSHOT_PATH} — run \`npm run seed\` first`);
  }
  closeWorkingDb();
  rmFiles(WORKING_PATH);
  copyFileSync(SNAPSHOT_PATH, WORKING_PATH);
  // Copy any sidecar files that exist (should be none if the snapshot was
  // checkpointed, but be defensive).
  for (const s of ["-wal", "-shm"]) {
    if (existsSync(SNAPSHOT_PATH + s)) copyFileSync(SNAPSHOT_PATH + s, WORKING_PATH + s);
  }
  const db = getDb();
  startNewSession(db, note);
  return { events: countEvents(db), calendars: countCalendars(db) };
}

/**
 * Promote the current working DB to the pristine snapshot — how a generated
 * world becomes the baseline every later run resets back to. Checkpoints the
 * WAL first so the single .db file is complete.
 */
export function snapshotWorking(): ResetResult {
  const db = getDb();
  const result = { events: countEvents(db), calendars: countCalendars(db) };
  db.pragma("wal_checkpoint(TRUNCATE)");
  closeWorkingDb();
  rmFiles(SNAPSHOT_PATH);
  copyFileSync(WORKING_PATH, SNAPSHOT_PATH);
  getDb();
  return result;
}
