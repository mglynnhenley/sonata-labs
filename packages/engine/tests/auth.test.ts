import { describe, it, expect } from "vitest";
import { createTwinHttp } from "../src/http";
import { modelCallError } from "../src/llm";
import { fetchFake } from "./fixtures";

// Which credential reaches which route.
//
// This is the failure that has cost this repo the most and left the least
// evidence: Gmail moved behind a real OAuth2 server, one of the three places
// that build a client kept handing it the static admin token, and every
// `/gmail/v1/*` call 401'd while the typecheck and every other suite stayed
// green. The assertions below are about the header on the wire, because that is
// the only place the mistake is visible.

const ADMIN = "sandbox-token";

function client(twin: "gmail" | "slack" | "calendar", routes: Record<string, unknown>) {
  const fake = fetchFake(routes);
  return {
    fake,
    http: createTwinHttp(twin, {
      baseUrl: `http://${twin}.test`,
      token: ADMIN,
      fetchImpl: fake.fetch,
    }),
  };
}

function bearer(headers: Record<string, string> | undefined): string | undefined {
  return headers?.Authorization?.replace(/^Bearer\s+/, "");
}

describe("the credential each twin's provider API gets", () => {
  it("mints an OAuth access token for gmail and never sends the admin token to /gmail/v1", async () => {
    const { fake, http } = client("gmail", {
      "/api/sandbox/token": { access_token: "ya29.minted" },
      "/gmail/v1/users/me/messages": { messages: [] },
    });

    await http.get("/gmail/v1/users/me/messages");

    const mint = fake.find("/api/sandbox/token");
    expect(mint?.method).toBe("POST");
    expect(bearer(mint?.headers)).toBe(ADMIN);

    const call = fake.find("/gmail/v1/users/me/messages");
    expect(bearer(call?.headers)).toBe("ya29.minted");
    expect(call?.headers["X-Sandbox-Token"]).toBeUndefined();
  });

  it("keeps the admin token on gmail's control plane, which is not behind OAuth", async () => {
    const { fake, http } = client("gmail", { "/api/sandbox/reset": { ok: true } });

    await http.post("/api/sandbox/reset");

    expect(fake.find("/api/sandbox/token")).toBeUndefined();
    expect(bearer(fake.find("/api/sandbox/reset")?.headers)).toBe(ADMIN);
  });

  it("sends slack and calendar the static token, with no mint round trip", async () => {
    for (const twin of ["slack", "calendar"] as const) {
      const path = twin === "slack" ? "/api/conversations.list" : "/calendar/v3/users/me/calendarList";
      const { fake, http } = client(twin, { [path]: { ok: true } });

      await http.get(path);

      expect(fake.find("/api/sandbox/token")).toBeUndefined();
      expect(bearer(fake.find(path)?.headers)).toBe(ADMIN);
    }
  });

  it("lets a caller override the default, for a twin mid-cutover", async () => {
    const fake = fetchFake({
      "/api/sandbox/token": { access_token: "xoxb.minted" },
      "/api/conversations.list": { ok: true },
    });
    const http = createTwinHttp("slack", {
      baseUrl: "http://slack.test",
      token: ADMIN,
      fetchImpl: fake.fetch,
      oauth: true,
    });

    await http.get("/api/conversations.list");

    expect(bearer(fake.find("/api/conversations.list")?.headers)).toBe("xoxb.minted");
  });
});

describe("what a rejected key reads like", () => {
  // OpenRouter's own words for a key that was mistyped, deleted or never funded
  // are "User not found." and "Insufficient credits". Handed to a first-time
  // user verbatim, both read as a bug in Sonata rather than a thing they own.
  it("names the key and where to change it on a 401", () => {
    const err = modelCallError(Object.assign(new Error("User not found."), { status: 401 }), "m");
    expect(err.message).toContain("OPENROUTER_API_KEY");
    expect(err.message).toContain("Settings");
    expect(err.message).toContain("openrouter.ai/keys");
  });

  it("says what stops, and where to top up, on a 402", () => {
    const err = modelCallError(
      Object.assign(new Error("Insufficient credits"), { status: 402 }),
      "m",
    );
    expect(err.message).toContain("no credit left");
    expect(err.message).toContain("openrouter.ai/credits");
  });

  it("leaves anything else exactly as it was thrown", () => {
    const original = Object.assign(new Error("upstream timeout"), { status: 504 });
    expect(modelCallError(original, "m")).toBe(original);
  });
});
