import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// What a desk must never let the agent do.
//
// Three of these are the reason the desk can be a twin at all. A continuity
// week's rules are written against a simulated instant, so an agent that could
// move the clock could choose which deadlines it had met. An agent that could
// read the assessment could read the rules it is marked against. And an agent
// whose audit log absorbed the world's own scheduled events would look busy on
// a week it slept through.

let desk: typeof import("../src/lib/desk");
let routes: typeof import("../app/api/[...path]/route");
const directory = mkdtempSync(path.join(tmpdir(), "desk-boundary-"));

beforeAll(async () => {
  vi.stubEnv("SONATA_DESK_CASE", "E01");
  vi.stubEnv("SONATA_DESK_DB", path.join(directory, "desk.db"));
  vi.stubEnv("SANDBOX_TOKEN", "desk-agent");
  vi.stubEnv("SANDBOX_CONTROL_TOKEN", "desk-harness");
  desk = await import("../src/lib/desk");
  routes = await import("../app/api/[...path]/route");
  desk.seed();
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

function call(route: string, token: string | undefined, method = "GET", body?: unknown) {
  const handler = method === "GET" ? routes.GET : routes.POST;
  return handler(
    new Request(`http://localhost/api/${route}`, {
      method,
      headers: token ? { authorization: `Bearer ${token}`, "content-type": "application/json" } : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ path: route.split("?")[0]!.split("/") }) },
  );
}

const CONTROL_ROUTES: Array<[string, string, unknown]> = [
  ["sandbox/advance", "POST", { at: "2026-09-25T17:00:00.000Z", phase: "before" }],
  ["sandbox/assess", "POST", { completedThrough: null }],
  ["sandbox/snapshot", "GET", undefined],
  ["sandbox/seed", "POST", {}],
  ["sandbox/reset", "POST", {}],
  ["activity", "GET", undefined],
];

describe("the desk's control boundary", () => {
  it("refuses the agent's credential on every control route, and the clock does not move", async () => {
    const before = desk.health().simTimeISO;
    for (const token of [undefined, "desk-agent", "another-workplace-harness", "sandbox-token"]) {
      for (const [route, method, body] of CONTROL_ROUTES) {
        expect((await call(route, token, method, body)).status, `${route} as ${token}`).toBe(401);
      }
    }
    expect(desk.health().simTimeISO).toBe(before);
  });

  it("refuses the control credential on the agent's tools, so one token is never both", async () => {
    expect((await call("tools", "desk-harness")).status).toBe(401);
    expect((await call("tools/list_due", "desk-harness", "POST", { args: {} })).status).toBe(401);
  });

  it("ignores an instant supplied with a tool call — the desk owns simulated time", async () => {
    const opening = desk.health().simTimeISO;
    const response = await call("tools/list_due", "desk-agent", "POST", {
      args: {},
      at: "2026-09-25T16:00:00.000Z",
      simTimeISO: "2026-09-25T16:00:00.000Z",
    });
    expect(response.status).toBe(200);
    expect(desk.health().simTimeISO).toBe(opening);
  });

  it("will not run simulated time backwards", async () => {
    desk.advance("2026-09-21T11:15:00.000Z", "before");
    expect(() => desk.advance("2026-09-21T09:00:00.000Z", "before")).toThrow(/backwards/);
    expect(desk.health().simTimeISO).toBe("2026-09-21T11:15:00.000Z");
  });
});

describe("what the ledger records", () => {
  it("keeps the world's scheduled events out of the agent's audit log", async () => {
    // Several world events have fired by now from the advance above.
    const snapshot = desk.snapshot();
    const worldEvents = snapshot.events.filter((event) => event.actor === "world");
    expect(worldEvents.length).toBeGreaterThan(0);

    const audited = desk.activity(0);
    expect(audited.every((row) => row.twin === "desk")).toBe(true);
    expect(audited).toHaveLength(snapshot.events.filter((event) => event.actor === "agent").length);
  });

  it("refuses invented evidence and records the refusal as the agent's own action", async () => {
    const before = desk.activity(0).length;
    const response = await call("tools/update_case", "desk-agent", "POST", {
      args: { id: "C", state: "resolved", evidence: ["NO-SUCH-RECORD"] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, error: "unavailable-evidence" });

    // The refusal is evidence too: a week where the agent kept citing records
    // that do not exist reads very differently from one where it asked for them.
    const after = desk.activity(0);
    expect(after).toHaveLength(before + 1);
    expect(after[after.length - 1]!.actionType).toBe("blocked");
  });

  it("names an unknown tool rather than failing quietly", async () => {
    const response = await call("tools/not_a_real_verb", "desk-agent", "POST", { args: {} });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("not_a_real_verb") });
  });
});
