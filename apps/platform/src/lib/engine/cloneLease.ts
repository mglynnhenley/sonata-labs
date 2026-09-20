import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

// All workspaces on this machine may point at the same clone ports. A lease in
// platform.db would protect only one workspace; this store is shared per OS user.
const LEASE_DB = path.join(tmpdir(), `sonata-clone-leases-${process.getuid?.() ?? "local"}.db`);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

function resourceKey(address: string): string {
  const url = new URL(address);
  // These spellings reach the same local service.
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.hostname = "localhost";
  return url.origin;
}

export class ResourceBusyError extends Error {
  constructor(readonly holder: string) { super(`Resource is in use by ${holder}.`); }
}

export class CloneBusyError extends Error {
  constructor(readonly holder: string) {
    super(`The apps are in use by ${holder}. Wait for it to finish or stop it before starting another run or loading an environment.`);
    this.name = "CloneBusyError";
  }
}

/** Atomic across processes. Dead processes are reclaimed; live leases never expire mid-run. */
export function acquireResourceLease(
  resources: string[],
  holder: string,
  databasePath = LEASE_DB,
): () => void {
  const db = new Database(databasePath);
  const token = randomUUID();
  try {
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS leases (
      resource TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, holder TEXT NOT NULL
    )`);
    db.transaction(() => {
      for (const address of new Set(resources)) {
        const row = db.prepare("SELECT pid, holder FROM leases WHERE resource = ?").get(address) as
          { pid: number; holder: string } | undefined;
        if (row && alive(row.pid)) throw new ResourceBusyError(row.holder);
        db.prepare("INSERT OR REPLACE INTO leases (resource, token, pid, holder) VALUES (?, ?, ?, ?)")
          .run(address, token, process.pid, holder);
      }
    }).immediate();
  } catch (err) {
    db.close();
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    db.prepare("DELETE FROM leases WHERE token = ?").run(token);
    released = true;
    db.close();
  };
}

/** Clone origins share one lease even when callers spell localhost differently. */
export function acquireCloneLease(addresses: string[], holder: string, databasePath = LEASE_DB): () => void {
  try { return acquireResourceLease(addresses.map(resourceKey), holder, databasePath); }
  catch (error) { if (error instanceof ResourceBusyError) throw new CloneBusyError(error.holder); throw error; }
}
