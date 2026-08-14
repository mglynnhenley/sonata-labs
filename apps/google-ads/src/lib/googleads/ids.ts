import { randomBytes } from "node:crypto";

// Google Ads ids are decimal int64 rendered as JSON strings, so a sandbox-minted
// id has to be decimal digits too: an agent must not be able to tell a budget it
// created from one the world seeded, and the moment an id carries a letter it
// can. scripts/smoke-sdk.ts asserts a created budget's id matches /^\d{10,12}$/,
// which is the guard on that rule.

/** A decimal id in the Google Ads alphabet: 11 digits, never leading zero. */
function newDecimalId(digits: number): string {
  const bytes = randomBytes(digits);
  let out = String(1 + (bytes[0] % 9));
  for (let i = 1; i < digits; i++) out += String(bytes[i] % 10);
  return out;
}

// The only resource this clone mints — campaigns:mutate `create` is a documented
// 501, so there is no newCampaignId() to go stale beside it.
export function newBudgetId(): string {
  return newDecimalId(11);
}

/** 22 base64url chars — the shape of a real Google `requestId`. */
export function newRequestId(): string {
  return randomBytes(16).toString("base64url");
}

/** 16 lowercase-hex chars — audit session ids, not a Google-visible shape. */
export function newHexId(): string {
  return randomBytes(8).toString("hex");
}
