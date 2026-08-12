import { copyFileSync, existsSync, rmSync } from "node:fs";
import { getDb, closeWorkingDb, SNAPSHOT_PATH, WORKING_PATH } from "./db";
import { startNewSession } from "./audit";
import { countCampaigns } from "./store/campaigns";
import { countAdGroups } from "./store/adGroups";
import { countBudgets } from "./store/budgets";
import { countStatRows } from "./store/stats";

const SUFFIXES = ["", "-wal", "-shm"];

function rmFiles(base: string): void {
  for (const s of SUFFIXES) rmSync(base + s, { force: true });
}

export interface ResetResult {
  campaigns: number;
  adGroups: number;
  budgets: number;
  statRows: number;
}

function counts(db: ReturnType<typeof getDb>): ResetResult {
  return {
    campaigns: countCampaigns(db),
    adGroups: countAdGroups(db),
    budgets: countBudgets(db),
    statRows: countStatRows(db),
  };
}

/**
 * Reset the working DB to the pristine snapshot. Must run in-process because the
 * server holds the working SQLite handle: close it → delete working.db* → copy
 * snapshot → reopen. Starts a fresh audit session (audit.db is untouched, so the
 * trail survives).
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
  return counts(db);
}

/**
 * Promote the current working DB to the pristine snapshot — how a generated
 * account becomes the baseline every later run resets back to. Checkpoints the
 * WAL first so the single .db file is complete, and closes the handle before the
 * copy, so nothing may hold `db` past that line.
 */
export function snapshotWorking(): ResetResult {
  const db = getDb();
  const result = counts(db);
  db.pragma("wal_checkpoint(TRUNCATE)");
  closeWorkingDb();
  rmFiles(SNAPSHOT_PATH);
  copyFileSync(WORKING_PATH, SNAPSHOT_PATH);
  getDb();
  return result;
}
