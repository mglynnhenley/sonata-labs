import { describe, expect, it } from "vitest";
import { authorizedControlRequest, controlToken } from "../src/controlAuth";

const scoped = { SANDBOX_TOKEN: "agent-secret", SANDBOX_CONTROL_TOKEN: "harness-secret" };

describe("control credentials", () => {
  it.each([undefined, "agent-secret", "sandbox-token", "another-workplace-secret"])("rejects %s for a scoped workplace", token => {
    const req = new Request("http://localhost/api/sandbox/reset", {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    expect(authorizedControlRequest(req, scoped)).toBe(false);
  });

  it.each(["bearer", "header", "access_token", "token"])("accepts the harness through %s", kind => {
    const url = new URL("http://localhost/api/sandbox/reset");
    const headers: Record<string, string> = {};
    if (kind === "bearer") headers.authorization = "Bearer harness-secret";
    else if (kind === "header") headers["x-sandbox-token"] = "harness-secret";
    else url.searchParams.set(kind, "harness-secret");
    expect(authorizedControlRequest(new Request(url, { headers }), scoped)).toBe(true);
  });

  it("keeps shared developer token compatibility without accepting an absent credential", () => {
    expect(controlToken({})).toBe("sandbox-token");
    expect(controlToken({ SANDBOX_TOKEN: "custom-dev" })).toBe("custom-dev");
    expect(authorizedControlRequest(new Request("http://localhost"), {})).toBe(false);
    expect(authorizedControlRequest(new Request("http://localhost", {
      headers: { authorization: "Bearer custom-dev" },
    }), { SANDBOX_TOKEN: "custom-dev" })).toBe(true);
  });
});
