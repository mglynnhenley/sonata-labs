import { afterEach, expect, it, vi } from "vitest";
import { proxyToApi } from "../src/lib/proxy";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("refuses to promote a workplace browser or agent credential into control authority", async () => {
  vi.stubEnv("SANDBOX_TOKEN", "agent-only");
  vi.stubEnv("SANDBOX_CONTROL_TOKEN", "control-only");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const token of [undefined, "agent-only"]) {
    const req = new Request("http://localhost/api/sandbox/reset", {
      method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    expect((await proxyToApi(req, "/api/sandbox/reset", { method: "POST" })).status).toBe(401);
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("forwards an authenticated control request with the control token", async () => {
  vi.stubEnv("SANDBOX_CONTROL_TOKEN", "control-only");
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  const req = new Request("http://localhost/api/activity", { headers: { "x-sandbox-token": "control-only" } });
  expect((await proxyToApi(req, "/api/activity")).status).toBe(200);
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer control-only");
});

it("retains the shared manual development proxy when no scoped control token is configured", async () => {
  vi.stubEnv("SANDBOX_CONTROL_TOKEN", "");
  vi.stubEnv("SANDBOX_TOKEN", "manual-token");
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  expect((await proxyToApi(new Request("http://localhost/api/activity"), "/api/activity")).status).toBe(200);
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer manual-token");
});
