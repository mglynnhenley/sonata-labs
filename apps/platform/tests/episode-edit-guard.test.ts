import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Criterion, EpisodeSpec } from "@sonata/core";
import { fakeAdapter, spec } from "../../../packages/engine/tests/fixtures";

// A SCENARIO'S RUBRIC DOES NOT MOVE WHILE A DAY IS BEING PLAYED AGAINST IT.
//
// docs/benchmark-realism-plan.md §1: criteria, prompts and ticks are not amended
// during a run. The Grading panel PATCHes all six of those, and until the guard
// under test it did so with no look at what was in flight. The cases below are
// the ones that matter in both directions: a live run or session on THIS
// scenario refuses; a finished one, or a live one on some OTHER scenario, must
// not — a benchmark that cannot be edited because something unrelated is running
// is its own kind of broken.
//
// Offline, in a temp cwd. `db.ts` and the document store both resolve their
// database against `process.cwd()` at import time, so the chdir comes first.

const mocks = vi.hoisted(() => ({
  adapters: vi.fn(), director: vi.fn(), loadClone: vi.fn(), key: vi.fn(), ensure: vi.fn(),
}));
vi.mock("@sonata/engine", async (original) => ({
  ...await original<typeof import("@sonata/engine")>(),
  createAdapters: mocks.adapters,
  createDirector: mocks.director,
}));
vi.mock("../src/lib/engine/preflight", () => ({
  ensureTwins: mocks.ensure,
  loadClone: mocks.loadClone,
  twinUrlMap: (twins: string[]) =>
    Object.fromEntries(twins.map((t) => [t, `http://edit-guard-test-${t}.invalid:19000`])),
}));
vi.mock("../src/lib/engine/workplace", () => ({ bindWorkplaceUrls: (value: unknown) => value, prepareWorkplace: async (id: string, twins: string[]) => ({
  agentUrls: Object.fromEntries(twins.map(t => [t, `http://agent-${id}-${t}.invalid:19000`])),
  agentContainer: `container-${id}`, images: { version: 1, sourceSha256: "test", apps: { image: "apps", id: "apps-id" }, agent: { image: "agent", id: "agent-id" } },
  scenarioSha256: "scenario-hash", scriptHashes: { "gateway.mjs": "test" },
  directory: `/test/${id}`, urls: Object.fromEntries(twins.map(t => [t, `http://${id}-${t}.invalid:19000`])),
  start: mocks.ensure, stop: async () => {}, snapshotHashes: () => ({}),
}) }));
vi.mock("../src/lib/engine/apiKey", () => ({ applyStoredApiKey: mocks.key }));
vi.mock("../src/lib/settings", () => ({ getSettings: () => ({ models: { director: "unused" } }) }));

const dir = mkdtempSync(path.join(tmpdir(), "sonata-edit-guard-"));
process.chdir(dir);
process.env.SONATA_RUNS_DIR = path.join(dir, "runs");

const { PATCH } = await import("../app/api/episodes/[episodeId]/route");
const { getEpisode, saveEpisode } = await import("../app/api/_lib/records");
const { liveWorkFor } = await import("../app/api/_lib/runner");
const { createRun, finishRun, getDb } = await import("../src/lib/db");
const { finalizeSession, startSession } = await import("../src/lib/engine/session");

const GUARDED = "ep-guarded";
const OTHER = "ep-other";
const WORLD = { id: "wld-test", name: "Test Co" };

/** Enough decidable criteria to clear the route's own "would this score a day" floor. */
const checklist: Criterion[] = [
  { id: "c1", description: "Dana got a reply", twin: "gmail", kind: "replied", severity: "must", weight: 1 } as Criterion,
  { id: "c2", description: "Sam was told", twin: "slack", kind: "posted", severity: "should", weight: 1 } as Criterion,
];

function scenario(id: string): EpisodeSpec {
  return spec({ id, title: `Day ${id}`, success: { checklist, judgeQuestions: [] } });
}

function patch(episodeId: string, body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/episodes/${episodeId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ episodeId }) },
  );
}

let n = 0;
/** A row exactly as `sonata run` leaves one from another machine: owned, and beating. */
function liveRun(episodeId: string): string {
  const id = `run_guard_${++n}`;
  createRun({
    id,
    episodeId,
    episodeTitle: `Day ${episodeId}`,
    model: "test/model",
    totalTicks: 4,
    status: "running",
    owner: { pid: 424242, host: "some-other-machine" },
  });
  return id;
}

const sessions: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapters.mockReturnValue([fakeAdapter("gmail"), fakeAdapter("slack")]);
  mocks.ensure.mockResolvedValue([]);

  const db = getDb();
  db.prepare("DELETE FROM runs").run();
  db.prepare(
    `INSERT OR IGNORE INTO worlds (id, name, description, industry, prompt, cast_size,
                                   channel_count, seed_json, created_at)
     VALUES (?, ?, '', '', '', 0, 0, '{}', 0)`,
  ).run(WORLD.id, WORLD.name);
  // `saveEpisode` mirrors into the relational table the run rows key on.
  saveEpisode(scenario(GUARDED), WORLD, null);
  saveEpisode(scenario(OTHER), WORLD, null);
});

afterEach(async () => {
  for (const id of sessions.splice(0)) await finalizeSession(id, { status: "aborted" });
});

describe("editing a scenario while a run is playing it", () => {
  it("is refused, names the run, and leaves the spec exactly as it was", async () => {
    const runId = liveRun(GUARDED);

    const response = await patch(GUARDED, { title: "Renamed mid-run", ticks: 12 });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain(runId);
    expect(body.error).toMatch(/rubric mid-run/);
    expect(body.error).toMatch(/abort/);
    expect(body.live).toEqual({ kind: "run", id: runId });

    const saved = getEpisode(GUARDED)!;
    expect(saved.spec.title).toBe(`Day ${GUARDED}`);
    expect(saved.spec.clock.ticks).toBe(4);
  });

  it("is allowed again the moment that run is over", async () => {
    const runId = liveRun(GUARDED);
    finishRun({ id: runId, status: "done" });

    const response = await patch(GUARDED, { title: "Renamed after the day" });
    expect(response.status).toBe(200);
    expect(getEpisode(GUARDED)!.spec.title).toBe("Renamed after the day");
    expect(liveWorkFor(GUARDED)).toBeUndefined();
  });

  it("is not blocked by a live run of some other scenario", async () => {
    liveRun(OTHER);

    const response = await patch(GUARDED, { ticks: 8 });
    expect(response.status).toBe(200);
    expect(getEpisode(GUARDED)!.spec.clock.ticks).toBe(8);
    // And the other scenario is, as it should be, still locked.
    expect((await patch(OTHER, { ticks: 8 })).status).toBe(409);
  });
});

describe("editing a scenario while an external agent's session is playing it", () => {
  it("is refused by session id, and allowed once the session is finalised", async () => {
    const session = startSession({
      episodeId: GUARDED, compression: 60, seedWorld: false, director: false, judge: false,
    });
    sessions.push(session.sessionId);

    const refused = await patch(GUARDED, { story: "A different morning" });
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body.error).toContain(session.sessionId);
    expect(body.live).toEqual({ kind: "session", id: session.sessionId });
    expect(getEpisode(GUARDED)!.spec.story).toBe("Dana has been waiting since Tuesday.");

    await finalizeSession(session.sessionId, { status: "aborted" });
    sessions.length = 0;

    const allowed = await patch(GUARDED, { story: "A different morning" });
    expect(allowed.status).toBe(200);
    expect(getEpisode(GUARDED)!.spec.story).toBe("A different morning");
  });
});
