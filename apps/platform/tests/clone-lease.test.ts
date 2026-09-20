import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { acquireCloneLease, CloneBusyError } from "../src/lib/engine/cloneLease";

describe("shared clone leases", () => {
  it("blocks overlapping surfaces across connections, rolls back a partial claim, and releases safely", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sonata-lease-test-"));
    const file = path.join(dir, "locks.db");
    const release = acquireCloneLease(["http://localhost:3101"], "run A", file);
    try {
      expect(() => acquireCloneLease(["http://localhost:3200", "http://127.0.0.1:3101/path"], "run B", file))
        .toThrow(CloneBusyError);
      // The failed multi-app acquisition must not retain its first app.
      const other = acquireCloneLease(["http://localhost:3200"], "session C", file);
      other();
      release();
      const next = acquireCloneLease(["http://localhost:3101"], "run D", file);
      release(); // An old release cannot remove the new holder.
      expect(() => acquireCloneLease(["http://localhost:3101"], "run E", file)).toThrow(/run D/);
      next();
    } finally { release(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("honours a live process in another workspace and recovers its lease after it exits", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sonata-lease-process-"));
    const file = path.join(dir, "locks.db");
    acquireCloneLease([], "initialise", file)();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (!child.pid) throw new Error("could not start fixture process");
    const closed = new Promise<void>(resolve => child.once("exit", () => resolve()));
    const db = new Database(file);
    try {
      db.prepare("INSERT INTO leases VALUES (?, ?, ?, ?)")
        .run("http://localhost:3101", "other-workspace", child.pid, "external session");
      expect(() => acquireCloneLease(["http://localhost:3101"], "my run", file)).toThrow(/external session/);
      child.kill();
      await closed;
      const release = acquireCloneLease(["http://localhost:3101"], "my run", file);
      release();
      expect(db.prepare("SELECT * FROM leases").all()).toHaveLength(0);
    } finally {
      child.kill();
      await closed;
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
