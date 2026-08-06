import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// WHEN A ROW IS ALLOWED TO SAY "running".
//
// A run sat on Home reading "Running · Tick 2 of 4" for twenty-three hours, its
// counter past 1289 minutes, its last event "the model call failed: Connection
// error." Nothing was driving it: the process that had been died, and the row it
// left behind was never asked about. `listLiveRuns` selected on status alone.
//
// The fix is ownership, and the trap in the fix is that this table has more than
// one writer. The dashboard cannot conclude a run is dead from "I am not driving
// it" — `sonata run` drives days from a different process entirely, and that
// reasoning would kill a live one the moment somebody opened a page. So the
// tests below come in pairs: every case that must retire a run is matched by the
// case that looks identical from here and must NOT.
//
// Offline, and in a temp cwd — `db.ts` resolves its database against
// `process.cwd()` at import time, so the chdir comes before the import.

const sandbox = mkdtempSync(path.join(os.tmpdir(), "sonata-liveness-"));
process.chdir(sandbox);

const {
  claimRun,
  createRun,
  getDb,
  getRun,
  heartbeatRun,
  listLiveRuns,
  reconcileLiveRuns,
  reconcileRun,
  thisProcess,
  updateRunProgress,
  HEARTBEAT_STALE_MS,
} = await import("../src/lib/db");

const HERE = thisProcess();
/** What the web process claims when it is driving nothing at all. */
const DRIVING_NOTHING = { owner: HERE, runIds: new Set<string>() };

const children: ReturnType<typeof spawn>[] = [];

/** A real second process, standing in for `sonata run` in a terminal. */
function otherProcess(): { pid: number; host: string; stop: () => Promise<void> } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  children.push(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("the stand-in process did not start");
  return {
    pid,
    host: os.hostname(),
    stop: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      }),
  };
}

let n = 0;

function makeRun(input: {
  status?: "queued" | "running" | "judging";
  owner?: { pid: number; host: string };
  startedAt?: number;
}): string {
  const id = `run_test_${++n}`;
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO worlds (id, name, description, industry, prompt, cast_size,
                                   channel_count, seed_json, created_at)
     VALUES ('w1', 'Test Co', '', '', '', 0, 0, '{}', 0)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO episodes (id, world_id, title, story, template_id, twins, ticks,
                                     spec_json, created_at)
     VALUES ('e1', 'w1', 'A day', '', NULL, 'gmail', 4, '{}', 0)`,
  ).run();
  createRun({
    id,
    episodeId: "e1",
    episodeTitle: "A day",
    model: "test/model",
    totalTicks: 4,
    status: input.status ?? "running",
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    ...(input.owner ? { owner: input.owner } : {}),
  });
  return id;
}

/** Wind a run's proof of life back into the past, as a crash does. */
function silentSince(id: string, at: number): void {
  getDb().prepare("UPDATE runs SET heartbeat_at = ? WHERE id = ?").run(at, id);
}

beforeEach(() => {
  getDb().prepare("DELETE FROM runs").run();
});

afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
});

describe("a run driven from another process", () => {
  it("is left alone while that process is alive, however little this one knows", async () => {
    const cli = otherProcess();
    const id = makeRun({ owner: { pid: cli.pid, host: cli.host } });

    // The web process, reconciling on a page load, driving nothing itself. The
    // naive rule — "nothing in this process is driving it, so it is over" —
    // would end a day that is mid-flight in somebody's terminal right here.
    reconcileLiveRuns(DRIVING_NOTHING);
    reconcileRun(id, DRIVING_NOTHING);

    expect(getRun(id)?.status).toBe("running");
    expect(listLiveRuns().map((r) => r.id)).toContain(id);
    await cli.stop();
  });

  it("keeps reading as live across a long silent tick, as long as it beats", async () => {
    const cli = otherProcess();
    const id = makeRun({ owner: { pid: cli.pid, host: cli.host } });
    // Ten minutes of model calls with no tick recorded — and then a beat.
    silentSince(id, Date.now() - 10 * 60_000);
    heartbeatRun(id);

    expect(listLiveRuns().map((r) => r.id)).toContain(id);
    await cli.stop();
  });

  it("is interrupted, not running, once that process is gone", async () => {
    const cli = otherProcess();
    const id = makeRun({ owner: { pid: cli.pid, host: cli.host } });
    updateRunProgress(id, { tick: 2, lastEvent: "the model call failed: Connection error." });
    const lastBeat = Date.now();
    await cli.stop();

    expect(listLiveRuns().map((r) => r.id)).not.toContain(id);
    const run = getRun(id);
    expect(run?.status).toBe("aborted");
    expect(run?.error).toMatch(/^Interrupted\./);
    // Its last known state, and the last thing it said.
    expect(run?.error).toContain("tick 2 of 4");
    expect(run?.error).toContain("the model call failed: Connection error.");
    // Ended when it was last seen, not when we noticed — the duration on the
    // card is read as measured, and "23 hours" was never measured.
    expect(run?.endedAt ?? 0).toBeLessThanOrEqual(lastBeat + 50);
  });
});

describe("a run this process owns", () => {
  it("survives reconciliation while this process says it is driving it", () => {
    const id = makeRun({ owner: HERE });
    reconcileLiveRuns({ owner: HERE, runIds: new Set([id]) });
    expect(getRun(id)?.status).toBe("running");
  });

  it("is retired at once when it is not, however fresh the last beat", () => {
    const id = makeRun({ owner: HERE });
    heartbeatRun(id);
    // Start-up: the pid on the row is ours, and our registry is empty, so the
    // driver died with the last incarnation. No need to wait out the silence.
    expect(reconcileLiveRuns(DRIVING_NOTHING)).toEqual([id]);
    expect(getRun(id)?.status).toBe("aborted");
  });
});

describe("a run owned by another host", () => {
  it("is left alone while its heartbeat is fresh", () => {
    const id = makeRun({ owner: { pid: 424242, host: "some-other-machine" } });
    reconcileLiveRuns(DRIVING_NOTHING);
    expect(getRun(id)?.status).toBe("running");
  });

  it("is retired on silence, the one signal that crosses a machine", () => {
    const id = makeRun({ owner: { pid: 424242, host: "some-other-machine" } });
    silentSince(id, Date.now() - HEARTBEAT_STALE_MS - 1_000);
    reconcileLiveRuns(DRIVING_NOTHING);
    expect(getRun(id)?.status).toBe("aborted");
  });
});

describe("the ghost", () => {
  it("is cleaned up by the read that used to show it", () => {
    // A row exactly as the old code left one: no owner, no heartbeat, "running"
    // since yesterday afternoon, its last event a failed model call.
    const startedAt = Date.now() - 23 * 60 * 60_000;
    const id = makeRun({ startedAt });
    getDb()
      .prepare("UPDATE runs SET tick = 2, last_event = ?, heartbeat_at = NULL WHERE id = ?")
      .run("the model call failed: Connection error.", id);

    expect(listLiveRuns()).toEqual([]);
    const run = getRun(id);
    expect(run?.status).toBe("aborted");
    expect(run?.error).toContain("tick 2 of 4");
    expect(run?.endedAt).toBe(startedAt);
  });
});

describe("a finished run", () => {
  it("cannot be resurrected by a beat that lands after it ended", () => {
    const id = makeRun({ owner: HERE });
    reconcileLiveRuns(DRIVING_NOTHING);
    heartbeatRun(id);
    claimRun(id, HERE);
    expect(getRun(id)?.status).toBe("aborted");
    expect(listLiveRuns()).toEqual([]);
  });
});
