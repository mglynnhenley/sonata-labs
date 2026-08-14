import { createHash, randomBytes } from "node:crypto";

// Id minting in the vendor's real alphabets. Agents string-match ids straight
// out of a docs.google.com/document/d/<id>/edit link, so a sandbox-created
// document has to look exactly like a seeded one — an id in the wrong shape is
// the cheapest possible tell that this is not the real API.

const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

function pick(alphabet: string, length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/**
 * A Google Docs file id: 44 url-safe base64 characters beginning with `1`
 * (e.g. `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms`).
 */
export function newDocumentId(): string {
  return "1" + pick(URL_SAFE, 43);
}

/** An opaque revision id — 14 url-safe chars, the length the vendor's run to. */
export function newRevisionId(): string {
  return randomBytes(10).toString("base64url").slice(0, 14);
}

/**
 * The revision id for content authored at a world instant rather than by an
 * agent. Deterministic on purpose: seeded and injected documents are authored at
 * the world's clock, so re-seeding the same world twice has to produce the same
 * documents — a random revision id would make two identical worlds compare
 * unequal in a snapshot diff.
 */
export function seededRevisionId(documentId: string, atMs: number): string {
  return createHash("sha256")
    .update(`${documentId}:${atMs}`)
    .digest("base64url")
    .slice(0, 14);
}

/** A named range id: `kix.` + 12 lowercase alphanumerics. */
export function newNamedRangeId(): string {
  return "kix." + pick(LOWER_ALNUM, 12);
}

/** A heading anchor id: `h.` + 12 lowercase alphanumerics. */
export function newHeadingId(): string {
  return "h." + pick(LOWER_ALNUM, 12);
}

/** 16 lowercase-hex chars — audit session ids, explicitly not a Docs shape. */
export function newHexId(): string {
  return randomBytes(8).toString("hex");
}
