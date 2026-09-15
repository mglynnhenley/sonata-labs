import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireSandboxToken } from "../src/lib/sandbox/auth";

import * as route0 from "../app/api/sandbox/auth-mode/route";
import * as route1 from "../app/api/sandbox/inject/route";
import * as route2 from "../app/api/sandbox/reset/route";
import * as route3 from "../app/api/sandbox/seed/route";
import * as route4 from "../app/api/sandbox/snapshot/route";
import * as route5 from "../app/api/sandbox/token/route";
import * as route6 from "../app/api/activity/route";
import * as route7 from "../app/api/eval/inject/route";
import * as route8 from "../app/api/eval/runs/[runId]/judge/route";
import * as route9 from "../app/api/eval/runs/[runId]/route";
import * as route10 from "../app/api/eval/runs/[runId]/trace/route";
import * as route11 from "../app/api/eval/runs/route";
import * as route12 from "../app/api/eval/scenarios/route";
const routes = {
  "app/api/sandbox/auth-mode/route.ts": route0,
  "app/api/sandbox/inject/route.ts": route1,
  "app/api/sandbox/reset/route.ts": route2,
  "app/api/sandbox/seed/route.ts": route3,
  "app/api/sandbox/snapshot/route.ts": route4,
  "app/api/sandbox/token/route.ts": route5,
  "app/api/activity/route.ts": route6,
  "app/api/eval/inject/route.ts": route7,
  "app/api/eval/runs/[runId]/judge/route.ts": route8,
  "app/api/eval/runs/[runId]/route.ts": route9,
  "app/api/eval/runs/[runId]/trace/route.ts": route10,
  "app/api/eval/runs/route.ts": route11,
  "app/api/eval/scenarios/route.ts": route12,
} as unknown as Record<string, Record<string, (req: Request, ctx: unknown) => Response | Promise<Response>>>;

beforeEach(() => {
  vi.stubEnv("SANDBOX_TOKEN", "agent-only");
  vi.stubEnv("SANDBOX_CONTROL_TOKEN", "control-only");
});
afterEach(() => vi.unstubAllEnvs());

describe("control routes", () => {
  for (const [path, route] of Object.entries(routes)) {
    for (const method of ["GET", "POST", "DELETE"]) {
      if (!route[method]) continue;
      it(`${method} ${path} rejects provider credentials before reading or changing state`, async () => {
        for (const token of [undefined, "agent-only"]) {
          const req = new Request("http://localhost/api/test", {
            method, headers: token ? { authorization: `Bearer ${token}` } : {},
          });
          const res = await route[method](req, { params: Promise.resolve({ runId: "missing" }) });
          expect(res.status).toBe(401);
          expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
        }
      });
    }
  }
  it("accepts control authority and preserves shared development token fallback", () => {
    expect(requireSandboxToken(new Request("http://localhost/", { headers: { authorization: "Bearer control-only" } }))).toBeNull();
    vi.stubEnv("SANDBOX_CONTROL_TOKEN", "");
    expect(requireSandboxToken(new Request("http://localhost/", { headers: { authorization: "Bearer agent-only" } }))).toBeNull();
  });
});
