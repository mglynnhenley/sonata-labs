import { copyFileSync, existsSync, rmSync } from "node:fs";
import { startNewSession } from "./audit";
import { closeWorkingDb, getDb, SNAPSHOT_PATH, WORKING_PATH } from "./db";
import { countDocuments, countParagraphs } from "./store/documents";

const SUFFIXES = ["", "-wal", "-shm"];

function rmFiles(base: string): void {
  for (const s of SUFFIXES) rmSync(base + s, { force: true });
}

export interface ResetResult {
  documents: number;
  paragraphs: number;
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
  // Copy any sidecar files that exist (there should be none if the snapshot was
  // checkpointed, but a half-old database is the worst thing a reset can leave).
  for (const s of ["-wal", "-shm"]) {
    if (existsSync(SNAPSHOT_PATH + s)) copyFileSync(SNAPSHOT_PATH + s, WORKING_PATH + s);
  }
  const db = getDb();
  startNewSession(db, note);
  return { documents: countDocuments(db), paragraphs: countParagraphs(db) };
}

/**
 * Promote the current working DB to the pristine snapshot — how a generated
 * world becomes the baseline every later run resets back to. Checkpoints the WAL
 * first so the single .db file is complete, and closes the handle across the
 * swap, so nothing may hold the `db` reference past this call.
 */
export function snapshotWorking(): ResetResult {
  const db = getDb();
  const result = { documents: countDocuments(db), paragraphs: countParagraphs(db) };
  db.pragma("wal_checkpoint(TRUNCATE)");
  closeWorkingDb();
  rmFiles(SNAPSHOT_PATH);
  copyFileSync(WORKING_PATH, SNAPSHOT_PATH);
  getDb();
  return result;
}
