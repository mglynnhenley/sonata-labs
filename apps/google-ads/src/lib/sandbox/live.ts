import { statSync } from "node:fs";
import type { Database } from "better-sqlite3";
import { closeWorkingDb, getDb, WORKING_PATH } from "../db";

// The working DB the sandbox routes serve, checked against the file that is
// actually on disk.
//
// The server holds one long-lived SQLite handle on globalThis. Anything that
// replaces working.db from OUTSIDE this process — `npm run seed`, a restore by
// hand — unlinks that file and writes a new one, and the open handle happily
// goes on serving the old, now-nameless inode. That is how an account with five
// seeded campaigns answers `/api/sandbox/snapshot` with empty arrays: the twin
// is not wrong about its own state, it is looking at a file nobody else can see
// any more.
//
// A swap always produces a new inode (every writer deletes before it copies),
// while this process's own writes never change it — so the inode is the whole
// check, and an ordinary request pays one stat for it.

const g = globalThis as unknown as { __googleAdsSandboxWorkingInode?: number };

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
  if (g.__googleAdsSandboxWorkingInode !== inode) closeWorkingDb();
  const db = getDb();
  // Read back after opening: a missing file has just been created by getDb().
  g.__googleAdsSandboxWorkingInode = inodeOf(WORKING_PATH);
  return db;
}

/** A swap this process did itself (seed, reset) — already reopened, just record it. */
export function markWorkingSwapped(): void {
  g.__googleAdsSandboxWorkingInode = inodeOf(WORKING_PATH);
}
