import { copyFileSync, existsSync, rmSync } from "node:fs";
import { getDb, closeWorkingDb, SNAPSHOT_PATH, WORKING_PATH } from "./db";
import { startNewSession } from "./audit";
import { liveDb, markWorkingSwapped } from "./sandbox/live";
import { countRecords } from "./store/records";
import { countNotes } from "./store/notes";
import { countTasks } from "./store/tasks";

const SUFFIXES = ["", "-wal", "-shm"];

function rmFiles(base: string): void {
  for (const s of SUFFIXES) rmSync(base + s, { force: true });
}

export interface ResetResult {
  records: number;
  notes: number;
  tasks: number;
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
  // checkpointed, but be defensive).
  for (const s of ["-wal", "-shm"]) {
    if (existsSync(SNAPSHOT_PATH + s)) copyFileSync(SNAPSHOT_PATH + s, WORKING_PATH + s);
  }
  const db = getDb();
  // This process did the swap, so record the new inode rather than making the
  // next liveDb() close a handle it just opened.
  markWorkingSwapped();
  startNewSession(db, note);
  return { records: countRecords(db), notes: countNotes(db), tasks: countTasks(db) };
}

/**
 * Promote the current working DB to the pristine snapshot — how a generated
 * world becomes the baseline every later run resets back to. The checkpoint
 * before the copy is not optional: without it the snapshot is missing the most
 * recent writes, which are still sitting in the WAL.
 */
export function snapshotWorking(): ResetResult {
  // liveDb() for the same reason the wire seeder uses it: the counts reported
  // back and the WAL checkpointed here have to belong to the working.db that is
  // on disk right now. Promote through a handle another process swapped away and
  // the baseline every later reset returns to is a world nobody asked for,
  // announced with the record counts of a file that no longer has a name.
  const db = liveDb();
  const result = {
    records: countRecords(db),
    notes: countNotes(db),
    tasks: countTasks(db),
  };
  db.pragma("wal_checkpoint(TRUNCATE)");
  closeWorkingDb();
  rmFiles(SNAPSHOT_PATH);
  copyFileSync(WORKING_PATH, SNAPSHOT_PATH);
  getDb();
  markWorkingSwapped();
  return result;
}
