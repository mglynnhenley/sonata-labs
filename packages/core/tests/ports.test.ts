import { describe, expect, it } from "vitest";
import { TWIN_NAMES } from "../src/types/world";
import {
  TWIN_API_PORTS,
  TWIN_UI_PORTS,
  TWINS_WITH_UI,
  allTwinApiUrls,
  hasUiService,
  resolveTwinApiUrl,
  resolveTwinUiUrl,
  twinApiUrl,
  twinUiUrl,
} from "../src/ports";

describe("port allocation", () => {
  // Every one of these numbers is written down somewhere else too — a dev script,
  // an env fallback, a clone's own README — so renumbering any of them has to be
  // a decision rather than an edit, and this is what makes it one.
  it("keeps the API ports every existing env fallback already assumes", () => {
    expect(TWIN_API_PORTS).toEqual({
      gmail: 3101,
      slack: 3200,
      calendar: 3400,
      attio: 3500,
      "google-docs": 3600,
      "google-ads": 3700,
      linkedin: 3800,
    });
  });

  it("puts each UI 800 above its API, so the pairing is guessable", () => {
    for (const twin of TWIN_NAMES) {
      expect(TWIN_UI_PORTS[twin] - TWIN_API_PORTS[twin]).toBe(800);
    }
  });

  it("assigns every twin a port, and never the same one twice", () => {
    const all = [...Object.values(TWIN_API_PORTS), ...Object.values(TWIN_UI_PORTS)];
    expect(all).toHaveLength(TWIN_NAMES.length * 2);
    expect(new Set(all).size).toBe(all.length);
  });

  it("only claims a UI for twins that actually ship one", () => {
    expect(TWINS_WITH_UI).toEqual(["gmail"]);
    expect(hasUiService("gmail")).toBe(true);
    expect(hasUiService("slack")).toBe(false);
  });
});

describe("url building", () => {
  it("builds localhost urls by default", () => {
    expect(twinApiUrl("gmail")).toBe("http://localhost:3101");
    expect(twinUiUrl("gmail")).toBe("http://localhost:3901");
  });

  it("honours a host override, for callers that need the literal loopback", () => {
    expect(twinApiUrl("slack", { host: "127.0.0.1" })).toBe("http://127.0.0.1:3200");
  });
});

describe("resolution precedence", () => {
  it("falls back to the default with an empty env", () => {
    expect(resolveTwinApiUrl("calendar", {})).toBe("http://localhost:3400");
  });

  it("accepts both env spellings, so no existing setup breaks", () => {
    // The dashboard, world builder and MCP server grew up on SONATA_*_URL...
    expect(resolveTwinApiUrl("gmail", { SONATA_GMAIL_URL: "http://a.test" })).toBe("http://a.test");
    // ...while the engine adapters grew up on *_TWIN_URL.
    expect(resolveTwinApiUrl("gmail", { GMAIL_TWIN_URL: "http://b.test" })).toBe("http://b.test");
  });

  it("prefers SONATA_* when both are set", () => {
    const env = { SONATA_GMAIL_URL: "http://a.test", GMAIL_TWIN_URL: "http://b.test" };
    expect(resolveTwinApiUrl("gmail", env)).toBe("http://a.test");
  });

  it("lets an explicit override beat the environment", () => {
    const env = { SONATA_GMAIL_URL: "http://a.test" };
    expect(resolveTwinApiUrl("gmail", env, { override: "http://c.test" })).toBe("http://c.test");
  });

  it("drops trailing slashes so callers can concatenate paths safely", () => {
    expect(resolveTwinApiUrl("gmail", { SONATA_GMAIL_URL: "http://a.test/" })).toBe("http://a.test");
    expect(resolveTwinApiUrl("gmail", {}, { override: "http://c.test///" })).toBe("http://c.test");
  });

  it("ignores an empty env value rather than resolving to an empty url", () => {
    expect(resolveTwinApiUrl("gmail", { SONATA_GMAIL_URL: "" })).toBe("http://localhost:3101");
  });

  it("resolves UI urls off their own env vars", () => {
    expect(resolveTwinUiUrl("gmail", {})).toBe("http://localhost:3901");
    expect(resolveTwinUiUrl("gmail", { SONATA_GMAIL_UI_URL: "http://ui.test" })).toBe("http://ui.test");
  });

  it("resolves every twin at once", () => {
    expect(allTwinApiUrls({ SONATA_SLACK_URL: "http://s.test" })).toEqual({
      gmail: "http://localhost:3101",
      slack: "http://s.test",
      calendar: "http://localhost:3400",
      attio: "http://localhost:3500",
      "google-docs": "http://localhost:3600",
      "google-ads": "http://localhost:3700",
      linkedin: "http://localhost:3800",
    });
  });
});
