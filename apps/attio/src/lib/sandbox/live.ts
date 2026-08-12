import { statSync } from "node:fs";
import type { Database } from "better-sqlite3";
import { closeWorkingDb, getDb, WORKING_PATH } from "../db";

// The working DB this app serves, checked against the file that is actually on
// disk.
//
// The server holds one long-lived SQLite handle on globalThis. Anything that
// replaces working.db from OUTSIDE this process — `npm run seed`, a restore by
// hand — unlinks that file and writes a new one, and the open handle happily
// goes on serving the old, now-nameless inode. That is how a CRM with nine
// seeded records answers /v2/objects/companies/records/query with an empty
// array: the twin is not wrong about its own state, it is looking at a file
// nobody else can see any more.
//
// A swap always produces a new inode (every writer deletes before it copies),
// while this process's own writes never change it — so the inode is the whole
// check, and an ordinary request pays one stat for it. Unlike the Gmail twin,
// the provider surface goes through here too rather than only the control
// plane, because an out-of-process seed is exactly as invisible to /v2/* as it
// is to /api/sandbox/*.

const g = globalThis as unknown as { __attioSandboxWorkingInode?: number };

function inodeOf(path: string): number {
  try {
    return statSync(path).ino;
  } catch {
    return 0;
  }
}

/** The working connection, reopened first if the file underneath it was swapped. */
export function liveDb(): Database {
  const inode = inodeOf(WORKING_PATH);
  // `undefined` means an untracked handle: opened by some other route before
  // this process ever looked, so its provenance is unknown and it may already
  // be stale. Closing it costs one reopen per boot and removes the whole class.
  if (g.__attioSandboxWorkingInode !== inode) closeWorkingDb();
  const db = getDb();
  // Read back after opening: a missing file has just been created by getDb().
  g.__attioSandboxWorkingInode = inodeOf(WORKING_PATH);
  return db;
}

/** A swap this process did itself (seed, reset) — already reopened, just record it. */
export function markWorkingSwapped(): void {
  g.__attioSandboxWorkingInode = inodeOf(WORKING_PATH);
}
