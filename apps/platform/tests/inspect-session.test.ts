import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditRow, beat, fakeAdapter, spec } from "../../../packages/engine/tests/fixtures";
import { recordLlmCall, withRole } from "@sonata/engine";

const mocks = vi.hoisted(() => ({
  adapters: vi.fn(), director: vi.fn(), loadClone: vi.fn(), key: vi.fn(),
  episode: vi.fn(), ensure: vi.fn(), stop: vi.fn(),
  credentials: vi.fn(),
}));
vi.mock("@sonata/engine", async (original) => ({
  ...await original<typeof import("@sonata/engine")>(),
  createAdapters: mocks.adapters,
  createDirector: mocks.director,
}));
vi.mock("../src/lib/engine/preflight", () => ({ loadClone: mocks.loadClone }));
vi.mock("@sonata/engine/http", async original => ({
  ...await original<typeof import("@sonata/engine/http")>(),
  createTwinHttp: () => ({ providerCredentials: mocks.credentials }),
}));
vi.mock("../src/lib/engine/workplace", () => ({ bindWorkplaceUrls: (value: unknown) => value, prepareWorkplace: async (id: string, twins: string[]) => ({
  agentUrls: Object.fromEntries(twins.map(t => [t, `http://agent-${id}-${t}.invalid:19000`])),
  agentContainer: `container-${id}`, images: { version: 1, sourceSha256: "test", apps: { image: "apps", id: "apps-id" }, agent: { image: "agent", id: "agent-id" } },
  scenarioSha256: "scenario-hash", scriptHashes: { "gateway.mjs": "test" },
  directory: `/test/${id}`, urls: Object.fromEntries(twins.map(t => [t, `http://${id}-${t}.invalid:19000`])),
  agentToken: `agent-${id}`, controlToken: `operator-${id}`,
  start: mocks.ensure, stop: mocks.stop, snapshotHashes: () => ({}),
}) }));
vi.mock("../src/lib/engine/apiKey", () => ({ applyStoredApiKey: mocks.key }));
vi.mock("../src/lib/settings", () => ({ getSettings: () => ({ models: { director: "unused" } }) }));
vi.mock("../src/lib/engine/scenarios", async original => ({
  ...await original<typeof import("../src/lib/engine/scenarios")>(),
  resolveScenario: mocks.episode,
}));

const dir = mkdtempSync(path.join(tmpdir(), "sonata-inspect-session-"));
process.chdir(dir);
process.env.SONATA_RUNS_DIR = path.join(dir, "runs");
const { startSession, sessionStatus, sessionLaunch, sessionConnection, finalizeSession, sweepOrphanSessions } = await import("../src/lib/engine/session");
const { getDb } = await import("../src/lib/db");
const { POST: startRoute } = await import("../app/api/sessions/route");
const { GET: resultRoute } = await import("../app/api/sessions/[sessionId]/result/route");
const { POST: finalizeRoute } = await import("../app/api/sessions/[sessionId]/finalize/route");
const { readTrace } = await import("../app/results/_lib/artifacts");

const ctx = (sessionId: string) => ({ params: Promise.resolve({ sessionId }) });
const request = (body: unknown) => new Request("http://localhost/api/sessions", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
let ids: string[] = [];
let excel = fakeAdapter("excel");
let gmail = fakeAdapter("gmail");

async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
function begin(director = false) {
  const session = startSession({ episodeId: "ep-test", compression: 60, seedWorld: false, director, judge: false });
  ids.push(session.sessionId);
  return session;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-17T08:00:00Z"));
  vi.clearAllMocks();
  excel = fakeAdapter("excel"); gmail = fakeAdapter("gmail");
  mocks.adapters.mockReturnValue([excel, gmail]);
  mocks.ensure.mockResolvedValue([]);
  mocks.stop.mockResolvedValue(undefined);
  mocks.credentials.mockResolvedValue({ accessToken: "mailbox-access", refreshToken: "mailbox-refresh", clientId: "sonata-harness" });
  const fixture = spec({
    story: "PRIVATE STORY NOT FOR AGENT",
    clock: { startISO: "2026-09-17T09:00:00+01:00", ticks: 2, simMinutesPerTick: 1 },
    beats: [beat({ id: "initial", tick: 0 })],
    success: { checklist: [{ id: "private-criterion", description: "PRIVATE ANSWER", twin: "excel", kind: "judged", severity: "must", weight: 1 }], judgeQuestions: [] },
  });
  mocks.episode.mockReturnValue({ id: fixture.id, title: fixture.title, worldId: "fixture-world", spec: fixture });
});
afterEach(async () => {
  for (const id of ids) await finalizeSession(id, { status: "aborted" });
  ids = [];
  vi.useRealTimers();
});

describe("Inspect session lifecycle", () => {
  it("hands the ready session's agent provider access without operator credentials", async () => {
    const session = begin();
    await flush();
    const launch = await sessionLaunch(session);
    expect(await sessionConnection(session.sessionId, "wrong-run")).toBeNull();
    expect(mocks.credentials).not.toHaveBeenCalled();
    const connection = await sessionConnection(session.sessionId, launch.connection.token);
    expect(connection?.gmailOAuth?.accessToken).toBe("mailbox-access");
    expect(JSON.stringify(connection)).not.toContain("operator-");
    await sessionConnection(session.sessionId, launch.connection.token);
    expect(mocks.credentials).toHaveBeenCalledTimes(1);
  });

  it.each(["done", "failed"] as const)("retains colleague model evidence when the session ends %s", async status => {
    mocks.director.mockReturnValue({ react: () => withRole("director", async () => {
      recordLlmCall({ model: "fixture/director", request: { prompt: "supplied context" },
        response: { events: [] }, startedAt: Date.now(), endedAt: Date.now(),
        costUsd: 0.01, tokens: { prompt: 12, completion: 3 } });
      return [];
    }) });
    const session = begin(true);
    await flush();
    if (status === "done") {
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
    } else {
      await finalizeSession(session.sessionId, { status: "failed", reason: "fixture harness failure" });
    }
    expect(sessionStatus(session.sessionId)?.session.status).toBe(status);
    const trace = readTrace(session.sessionId);
    expect(trace?.llmCalls.length).toBeGreaterThan(0);
    expect(trace?.llmCalls[0]).toMatchObject({ role: "director", model: "fixture/director",
      request: { prompt: "supplied context" }, response: { events: [] }, costUsd: 0.01 });
  });

  it("returns only public brief and exact tool addresses; scripted mode makes no model calls", async () => {
    const session = begin();
    const launch = await sessionLaunch(session);
    expect(launch.agentBrief).toContain("Keep the client informed");
    expect(JSON.stringify(launch)).not.toContain("PRIVATE");
    expect(launch.connection.urls.excel).toBe(`http://agent-${session.sessionId}-excel.invalid:19000`);
    expect(launch.timing.worldMode).toBe("scripted");
    await flush();
    expect(mocks.adapters).toHaveBeenCalledWith(expect.objectContaining({ excel: {
      baseUrl: `http://${session.sessionId}-excel.invalid:19000`, token: launch.connection.token, controlToken: `operator-${session.sessionId}`,
    } }));
    expect(mocks.director).not.toHaveBeenCalled();
    expect(mocks.key).not.toHaveBeenCalled();
    const second = begin();
    expect((await sessionLaunch(second)).connection.urls.excel).not.toBe(launch.connection.urls.excel);
    expect((await resultRoute(new Request("http://localhost"), ctx(session.sessionId))).status).toBe(409);
  });

  it("holds the last interval and captures its audit rows once before exposing a result", async () => {
    const session = begin();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sessionStatus(session.sessionId)?.session.status).toBe("running");
    excel.rows.push(auditRow({ id: 1, twin: "excel", ts: Date.now(), actionType: "update_cells" }));
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    const view = sessionStatus(session.sessionId)!.session;
    expect(view.status).toBe("done");
    expect(view.live).toBe(false);
    expect(view.agentActions).toBe(1);
    expect(view.beats).toBe(1);
    expect(view.tick).toBe(2);
    const response = await resultRoute(new Request("http://localhost"), ctx(session.sessionId));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.run.audit).toHaveLength(1);
    expect(result.run.ticks.at(-1).agentSteps).toHaveLength(1);
    expect(result.session.caveats.join(" ")).toContain("Scripted-only");
    // Repeated finalisation neither changes natural completion nor counts actions again.
    const final = await finalizeSession(session.sessionId, { status: "aborted" });
    expect(final?.status).toBe("done");
    expect(final?.agentActions).toBe(1);
  });

  it("preserves partial work for a harness failure and does not return a completed-day score", async () => {
    const session = begin();
    await flush();
    excel.rows.push(auditRow({ id: 1, twin: "excel", ts: Date.now(), actionType: "update_cells" }));
    const response = await finalizeRoute(request({ status: "failed", reason: "provider test failure" }), ctx(session.sessionId));
    expect(response.status).toBe(200);
    const final = (await response.json()).session;
    expect(final.status).toBe("failed");
    expect(final.live).toBe(false);
    expect(final.score).toBeNull();
    const result = await (await resultRoute(new Request("http://localhost"), ctx(session.sessionId))).json();
    expect(result.run.audit).toHaveLength(1);
    expect(result.run.verdict).toBeNull();
    expect(result.run.error).toContain("provider test failure");
  });

  it("keeps results pending until workspace capture finishes and removes the score if capture fails", async () => {
    let failCapture!: (error: Error) => void;
    mocks.stop.mockImplementation(() => new Promise<void>((_resolve, reject) => { failCapture = reject; }));
    const session = begin();
    await flush();
    excel.rows.push(auditRow({ id: 1, twin: "excel", ts: Date.now(), actionType: "update_cells" }));
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    const file = path.join(dir, "runs", `${session.sessionId}.json`);
    const before = JSON.parse(readFileSync(file, "utf8"));
    expect(before.audit).toHaveLength(1);
    expect(sessionStatus(session.sessionId)?.session.live).toBe(true);
    expect((await resultRoute(new Request("http://localhost"), ctx(session.sessionId))).status).toBe(409);
    const finishing = finalizeSession(session.sessionId, { status: "aborted" });
    failCapture(new Error("Archive exceeded the capture limit"));
    const final = await finishing;
    expect(final).toMatchObject({ status: "failed", live: false, score: null, autonomy: null,
      noResult: expect.stringContaining("capture or cleanup failed"), error: expect.stringContaining("Archive exceeded") });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.verdict).toBeNull();
    expect(saved.audit).toEqual(before.audit);
    expect(saved.ticks).toEqual(before.ticks);
    expect(saved.snapshots).toEqual(before.snapshots);
    expect(saved.workplace.cleanup.status).toBe("failed");
    expect((await resultRoute(new Request("http://localhost"), ctx(session.sessionId))).status).toBe(200);
  });

  it("retains the original provider failure when cleanup also fails", async () => {
    mocks.stop.mockRejectedValue(new Error("Workspace archive unavailable"));
    const session = begin();
    await flush();
    const final = await finalizeSession(session.sessionId, { status: "failed", reason: "original provider failure" });
    expect(final?.error).toContain("original provider failure");
    expect(final?.error).toContain("Workspace archive unavailable");
    const saved = JSON.parse(readFileSync(path.join(dir, "runs", `${session.sessionId}.json`), "utf8"));
    expect(saved.error).toContain("original provider failure");
    expect(saved.verdict).toBeNull();
  });

  it.each([false, true])("recovers pending capture after restart only when guardian evidence confirms completion (%s)", async captured => {
    const session = begin();
    await flush();
    excel.rows.push(auditRow({ id: 1, twin: "excel", ts: Date.now(), actionType: "update_cells" }));
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    const file = path.join(dir, "runs", `${session.sessionId}.json`);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const workplace = mkdtempSync(path.join(dir, "restarted-capture-"));
    saved.status = "judging";
    saved.workplace.directory = workplace;
    saved.workplace.cleanup.status = "pending";
    writeFileSync(file, JSON.stringify(saved));
    writeFileSync(path.join(workplace, "workplace.json"), JSON.stringify({ status: captured ? "stopped" : "ready",
      agentStarted: true, cleanupErrors: [], ...(captured ? { workspaceArchive: { status: "captured" } } : {}) }));
    getDb().prepare("UPDATE sessions SET no_result = ? WHERE id = ?")
      .run("The workplace's final capture and cleanup are still pending.", session.sessionId);
    sweepOrphanSessions();
    const recovered = JSON.parse(readFileSync(file, "utf8"));
    expect(recovered.status).toBe(captured ? "done" : "failed");
    expect(recovered.workplace.cleanup.status).toBe(captured ? "complete" : "failed");
    expect(recovered.audit).toEqual(saved.audit);
    expect(recovered.ticks).toEqual(saved.ticks);
    expect(recovered.snapshots).toEqual(saved.snapshots);
    if (!captured) {
      expect(recovered.verdict).toBeNull();
      expect(sessionStatus(session.sessionId)?.session.noResult).toContain("unmeasured");
    }
  });

  it("preserves completed evidence when a restart interrupts assessment", async () => {
    const session = begin();
    await flush();
    excel.rows.push(auditRow({ id: 1, twin: "excel", ts: Date.now(), actionType: "update_cells" }));
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(sessionStatus(session.sessionId)?.session.live).toBe(false);
    const file = path.join(dir, "runs", `${session.sessionId}.json`);
    const before = readFileSync(file, "utf8");
    expect(JSON.parse(before).audit).toHaveLength(1);
    expect(Object.keys(JSON.parse(before).snapshots).length).toBeGreaterThan(0);
    // This is the persisted state after capture succeeds but the process dies
    // while awaiting the judge: a terminal artifact and a still-judging row.
    getDb().prepare("UPDATE sessions SET status = 'judging' WHERE id = ?").run(session.sessionId);
    sweepOrphanSessions();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(sessionStatus(session.sessionId)?.session).toMatchObject({
      status: "done", error: expect.stringContaining("assessment status was saved"),
    });
    sweepOrphanSessions();
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("can cancel during preparation and stop the owned workplace", async () => {
    let ready!: () => void;
    mocks.ensure.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
    const session = begin();
    const ending = finalizeSession(session.sessionId, { status: "failed", reason: "setup cancelled" });
    ready();
    expect((await ending)?.status).toBe("failed");
    expect(sessionStatus(session.sessionId)?.session.live).toBe(false);
    mocks.ensure.mockResolvedValue([]);
    expect(() => begin()).not.toThrow();
  });

  it("rejects malformed mode and early-complete requests before touching the environment", async () => {
    for (const body of [
      { episodeId: "ep-test", director: "false" },
      { episodeId: "ep-test", compression: -1 },
      { episodeId: "ep-test", ticks: 0.5 },
      { episodeId: "ep-test", twins: ["unknown"] },
    ]) expect((await startRoute(request(body))).status).toBe(400);
    expect(mocks.episode).not.toHaveBeenCalled();
    expect((await finalizeRoute(request({ status: "done" }), ctx("missing"))).status).toBe(400);
  });
});
