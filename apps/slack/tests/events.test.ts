import { describe, it, expect } from "vitest";
import { signBody, verifySignature } from "@/lib/events/signing";

const SECRET = "test-secret";
const BODY = JSON.stringify({ type: "event_callback", event: { type: "message" } });

describe("event signing", () => {
  it("produces Slack's v0= HMAC format", () => {
    const sig = signBody(BODY, 1700000000, SECRET);
    expect(sig).toMatch(/^v0=[0-9a-f]{64}$/);
  });

  it("matches a known-good vector from Slack's docs", () => {
    // Slack's documented example: secret 8f742231b10e8888abcd99yyyzzz85a5,
    // timestamp 1531420618, body "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J..."
    const secret = "8f742231b10e8888abcd99yyyzzz85a5";
    const ts = 1531420618;
    const body =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    expect(signBody(body, ts, secret)).toBe(
      "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
    );
  });

  it("verifies a signature it produced", () => {
    const now = 1700000000;
    const sig = signBody(BODY, now, SECRET);
    expect(verifySignature(BODY, now, sig, { secret: SECRET, nowSec: now })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const now = 1700000000;
    const sig = signBody(BODY, now, SECRET);
    expect(
      verifySignature(BODY + "x", now, sig, { secret: SECRET, nowSec: now }),
    ).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const now = 1700000000;
    const sig = signBody(BODY, now, "other-secret");
    expect(verifySignature(BODY, now, sig, { secret: SECRET, nowSec: now })).toBe(false);
  });

  it("rejects replays outside the 5-minute window", () => {
    const signedAt = 1700000000;
    const sig = signBody(BODY, signedAt, SECRET);
    // 4 minutes later: still fine.
    expect(
      verifySignature(BODY, signedAt, sig, { secret: SECRET, nowSec: signedAt + 240 }),
    ).toBe(true);
    // 6 minutes later: stale.
    expect(
      verifySignature(BODY, signedAt, sig, { secret: SECRET, nowSec: signedAt + 360 }),
    ).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of ["", "v0=", "nonsense", "v0=zz"]) {
      expect(() =>
        verifySignature(BODY, 1700000000, bad, { secret: SECRET, nowSec: 1700000000 }),
      ).not.toThrow();
      expect(verifySignature(BODY, 1700000000, bad, { secret: SECRET, nowSec: 1700000000 })).toBe(
        false,
      );
    }
    expect(verifySignature(BODY, NaN, "v0=x", { secret: SECRET })).toBe(false);
  });
});
