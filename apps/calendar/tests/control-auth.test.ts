import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAuth, checkSandboxToken } from "../src/lib/calendar/auth";
import { POST as reset } from "../app/api/sandbox/reset/route";
import { POST as seed } from "../app/api/sandbox/seed/route";
import { POST as inject } from "../app/api/sandbox/inject/route";
import { POST as snapshot } from "../app/api/sandbox/snapshot/route";
import { GET as activity } from "../app/api/activity/route";

const calls = vi.hoisted(() => ({ reset: vi.fn(() => ({ events: 2 })), snapshot: vi.fn(() => ({ events: 2 })) }));
vi.mock("../src/lib/reset", () => ({ resetWorking: calls.reset, snapshotWorking: calls.snapshot }));

beforeEach(() => {
  vi.stubEnv("SANDBOX_CONTROL_TOKEN", "calendar-harness");
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

describe("calendar control boundary", () => {
  it("rejects absent, provider and another workplace credentials on every control handler", async () => {
    for (const token of [undefined, "sandbox-token", "different-workplace-harness"]) {
      for (const [route, handler] of Object.entries({ reset, seed, inject, snapshot, activity })) {
        const req = new Request(`http://localhost/api/${route === "activity" ? route : `sandbox/${route}`}`, {
          method: route === "activity" ? "GET" : "POST",
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        expect((await handler(req)).status, `${route}: ${token}`).toBe(401);
      }
    }
    expect(calls.reset).not.toHaveBeenCalled();
    expect(calls.snapshot).not.toHaveBeenCalled();
  });

  it("lets the harness reset while the provider token remains restricted to the calendar API", async () => {
    const req = new Request("http://localhost/api/sandbox/reset", {
      method: "POST", headers: { authorization: "Bearer calendar-harness" },
    });
    expect((await reset(req)).status).toBe(200);
    expect(calls.reset).toHaveBeenCalledOnce();
    expect(checkAuth(new Request("http://localhost/calendar/v3/", { headers: { authorization: "Bearer sandbox-token" } }))).toBeNull();
    expect(checkAuth(req)?.status).toBe(401);
    expect(checkSandboxToken(req)).toBeNull();
  });
});
