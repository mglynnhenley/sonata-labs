import { afterEach, expect, it, vi } from "vitest";
import { GET as callback } from "../app/oauth/callback/route";
import { GET as logout } from "../app/oauth/logout/route";

vi.mock("@/lib/oauth-config", () => ({
  API_URL: "http://127.0.0.1:43101", UI_CLIENT_ID: "ui", UI_CLIENT_SECRET: "test-secret",
  UI_REDIRECT_URI: "http://127.0.0.1:43901/oauth/callback",
}));
vi.mock("@/lib/session", () => ({
  takeFlow: vi.fn(async () => ({ state: "state", verifier: "verifier", next: "/?thread=thread1" })),
  setSession: vi.fn(), clearSession: vi.fn(), safeNextPath: (value: string) => value,
}));
afterEach(() => vi.unstubAllGlobals());

it("keeps OAuth redirects on the registered cookie host when Next normalizes the request host", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ access_token: "oauth-token", expires_in: 3600 })));
  const res = await callback(new Request("http://localhost:43901/oauth/callback?state=state&code=code"));
  expect(res.headers.get("location")).toBe("http://127.0.0.1:43901/?thread=thread1");
  expect((await logout()).headers.get("location")).toBe("http://127.0.0.1:43901/signed-out");
});
