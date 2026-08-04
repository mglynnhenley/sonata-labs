import { createHmac, timingSafeEqual } from "node:crypto";

// Slack signs every event delivery so receivers can prove it came from Slack:
//
//   basestring = "v0:" + timestamp + ":" + rawBody
//   signature  = "v0=" + HMAC_SHA256(signingSecret, basestring)
//
// sent as X-Slack-Signature + X-Slack-Request-Timestamp. Real agent frameworks
// (Bolt, and anything following Slack's docs) REJECT unsigned deliveries, so
// getting this exactly right is what makes the sandbox usable by them at all.

export const SIGNING_SECRET =
  process.env.SANDBOX_SIGNING_SECRET || "sandbox-signing-secret";

export function signBody(body: string, timestampSec: number, secret = SIGNING_SECRET): string {
  const base = `v0:${timestampSec}:${body}`;
  return "v0=" + createHmac("sha256", secret).update(base).digest("hex");
}

/**
 * Verify a signature the way a receiver should: constant-time compare, plus a
 * replay window (Slack recommends rejecting timestamps older than 5 minutes).
 */
export function verifySignature(
  body: string,
  timestampSec: number,
  signature: string,
  { secret = SIGNING_SECRET, nowSec = Math.floor(Date.now() / 1000), maxSkewSec = 300 } = {},
): boolean {
  if (!Number.isFinite(timestampSec)) return false;
  if (Math.abs(nowSec - timestampSec) > maxSkewSec) return false;
  const expected = Buffer.from(signBody(body, timestampSec, secret), "utf8");
  const actual = Buffer.from(signature ?? "", "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
