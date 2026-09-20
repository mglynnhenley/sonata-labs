import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireSandboxToken } from "@/lib/sandbox/auth";
import { SANDBOX_TOKEN, checkAuth } from "@/lib/docs/auth";
import { GET as activity } from "../app/api/activity/route";
import { POST as reset } from "../app/api/sandbox/reset/route";
import { POST as seed } from "../app/api/sandbox/seed/route";
import { POST as inject } from "../app/api/sandbox/inject/route";
import { GET as snapshotGET } from "../app/api/sandbox/snapshot/route";

const routes = [
  ["activity", "GET", activity],
  ["reset", "POST", reset],
  ["seed", "POST", seed],
  ["inject", "POST", inject],
  ["snapshot", "GET", snapshotGET],
] as const;

beforeEach(() => vi.stubEnv("SANDBOX_CONTROL_TOKEN", "harness-only-secret"));
afterEach(() => vi.unstubAllEnvs());

describe("control credentials", () => {
  for (const [route, method, handler] of routes) {
    it.each([undefined, "wrong-token", SANDBOX_TOKEN])(`${method} ${route} refuses credential %s before reading or mutating the workplace`, async (token) => {
      const response = await handler(new Request(`http://localhost/api/${route}`, {
        method,
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      }));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ ok: false, error: "unauthorized" });
    });
  }

  it("accepts the control credential through each supported transport", () => {
    const token = "harness-only-secret";
    const requests = [
      new Request("http://localhost/api/activity", { headers: { "x-sandbox-token": token } }),
      new Request("http://localhost/api/activity", { headers: { authorization: `Bearer ${token}` } }),
      new Request(`http://localhost/api/activity?access_token=${token}`),
      new Request(`http://localhost/api/activity?token=${token}`),
    ];
    for (const request of requests) expect(requireSandboxToken(request)).toBeNull();
  });

  it("keeps provider API credentials separate", () => {
    const request = (token: string) => new Request("http://localhost/provider", {
      headers: { authorization: `Bearer ${token}`, "developer-token": "test-developer" },
    });
    expect(checkAuth(request(SANDBOX_TOKEN))).toBeNull();
    expect(checkAuth(request("harness-only-secret"))).not.toBeNull();
  });

  it("retains the shared-token development fallback when no control token is configured", () => {
    vi.stubEnv("SANDBOX_CONTROL_TOKEN", "");
    expect(requireSandboxToken(new Request("http://localhost/api/activity", {
      headers: { "x-sandbox-token": SANDBOX_TOKEN },
    }))).toBeNull();
  });
});
