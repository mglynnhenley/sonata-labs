import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { trackDb } from "./helpers";

// What happens to the control plane when working.db is replaced underneath it.
//
// The other suites run in memory; this one cannot, because the whole defect is
// about files: `npm run seed` unlinks working.db and copies a new one, so the
// server's open handle keeps serving an inode with no name, and every write
// through it lands somewhere no other process can ever read. Only real files on
// a real disk reproduce that, and `src/lib/db.ts` resolves data/ and
// db/schema.sql off process.cwd() at import time — hence the temp cwd and the
// dynamic imports. A static import here would pin the paths to the real
// apps/attio/data and this suite would eat the developer's world.

const APP_ROOT = path.resolve(__dirname, "..");

const CAST = [
  { id: "p1", name: "Sandbox User", email: "sandbox.user@gmail.com" },
  { id: "p2", name: "Ana Mireles", email: "ana@northwind.example" },
];

/** A minimal but complete wire seed naming a company no demo world contains. */
function wireBody() {
  return {
    twin: "attio",
    seed: {
      world: { business: { name: "Staleco" }, cast: CAST, mailboxOwner: CAST[0].email },
      nowISO: "2026-07-27T13:00:00.000Z",
      ownerEmail: CAST[0].email,
      workspace: { name: "Staleco", slug: "staleco" },
      members: [{ id: "m1", email: CAST[0].email }],
      companies: [
        { id: "c1", name: "Stale Detector Ltd", domains: ["stale.example"], description: "" },
      ],
      people: [
        {
          id: "pe1",
          name: "Ana Mireles",
          email: CAST[1].email,
          jobTitle: "VP Operations",
          companyId: "c1",
        },
      ],
      deals: [],
      notes: [],
      tasks: [],
    },
  };
}

let originalCwd: string;
let tmp: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(path.join(os.tmpdir(), "attio-live-swap-"));
  mkdirSync(path.join(tmp, "db"));
  copyFileSync(path.join(APP_ROOT, "db", "schema.sql"), path.join(tmp, "db", "schema.sql"));
  process.chdir(tmp);
  vi.resetModules();
});

afterEach(async () => {
  // The handle lives on globalThis, which resetModules does not clear: leave it
  // behind and the next case inherits a connection to a deleted temp file.
  const { closeWorkingDb } = await import("@/lib/db");
  closeWorkingDb();
  const g = globalThis as Record<string, unknown>;
  delete g.__attioSandboxWorkingInode;
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A server that has already served one request: schema applied, and — the part
 * that matters — file descriptors open on working.db AND on its -wal. SQLite
 * creates the -wal lazily at the first transaction, and a handle with no -wal
 * open yet will happily adopt the one the NEXT writer creates by path, which
 * hides the whole defect. Warm it, and the swap strands the descriptors for
 * real, exactly as it does against a live dev server.
 */
async function warmServerHandle(): Promise<void> {
  const { applySchema } = await import("@/lib/db");
  const { liveDb } = await import("@/lib/sandbox/live");
  const db = liveDb();
  applySchema(db);
  db.prepare("SELECT COUNT(*) AS n FROM records").get();
}

/**
 * What `npm run seed` does to a running server: delete working.db and write a
 * fresh one, which is always a new inode. Optionally seeds the demo world into
 * it so the file on disk and the file the open handle sees differ in content.
 */
async function swapWorkingFileOutOfProcess(withDemoWorld: boolean): Promise<void> {
  const { WORKING_PATH, readSchema } = await import("@/lib/db");
  const { seedDatabase } = await import("@/lib/seed");
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(WORKING_PATH + suffix, { force: true });
  }
  const fresh = trackDb(new Database(WORKING_PATH));
  fresh.exec(readSchema());
  if (withDemoWorld) seedDatabase(fresh);
  fresh.pragma("wal_checkpoint(TRUNCATE)");
  fresh.close();
}

function rowCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Read the file itself, the way any other process would. */
async function onDisk<T>(read: (db: Database.Database) => T): Promise<T> {
  const { WORKING_PATH } = await import("@/lib/db");
  const db = trackDb(new Database(WORKING_PATH, { readonly: true }));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

describe("the control plane after an out-of-process working.db swap", () => {
  it("writes the wire seed into the file on disk, not into the swapped-away inode", async () => {
    const { seedFromWire } = await import("@/lib/sandbox/seed");
    const { parseSeedRequest } = await import("@/lib/sandbox/parse");

    await warmServerHandle();
    await swapWorkingFileOutOfProcess(false);

    const result = seedFromWire(parseSeedRequest(wireBody()));
    expect(result.counts.companies).toBe(1);

    const names = await onDisk((db) =>
      db
        .prepare(
          `SELECT v.text_value AS name FROM attribute_values v
             JOIN attributes a ON a.id = v.attribute_id
            WHERE a.api_slug = 'name' AND v.active_until_ms IS NULL`,
        )
        .all()
        .map((r) => (r as { name: string }).name),
    );
    expect(names).toContain("Stale Detector Ltd");
  });

  it("promotes the world that is on disk, and reports its real counts", async () => {
    const { snapshotWorking } = await import("@/lib/reset");

    // The stranded handle sees an empty-but-schema'd CRM, so a promote through
    // it answers with a wrong number rather than a missing-table error — the
    // failure a director would never think to distrust.
    await warmServerHandle();
    await swapWorkingFileOutOfProcess(true);

    // Taken from the file rather than written down, so the demo world can grow
    // without this suite going red for the wrong reason.
    const truth = await onDisk((db) => ({
      records: rowCount(db, "records"),
      notes: rowCount(db, "notes"),
      tasks: rowCount(db, "tasks"),
    }));
    expect(truth.records).toBeGreaterThan(0);

    expect(snapshotWorking()).toEqual(truth);
  });
});
