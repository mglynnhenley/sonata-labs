import { randomBytes } from "node:crypto";

// Id minting in LinkedIn's own alphabets, so a sandbox-created row is
// indistinguishable from a seeded one.

const SNOWFLAKE_SEQUENCE_BITS = 22n;
const SNOWFLAKE_SEQUENCE_MAX = 1 << 22;

/**
 * A 19-digit share/ugcPost id. LinkedIn's are snowflakes whose high bits carry
 * the creation timestamp, so sorting by id gives the same order as sorting by
 * publishedAt — an agent that relies on that gets the same answer here.
 *
 * Returned as a string throughout: 7.4e18 is well past Number.MAX_SAFE_INTEGER
 * and a single JSON.parse into a number would silently corrupt it.
 */
export function newPostId(atMs: number = Date.now()): string {
  const sequence = randomBytes(4).readUInt32BE(0) % SNOWFLAKE_SEQUENCE_MAX;
  return ((BigInt(atMs) << SNOWFLAKE_SEQUENCE_BITS) | BigInt(sequence)).toString();
}

/** Comment ids share the share-id shape, down to the timestamp in the high bits. */
export function newCommentId(atMs: number = Date.now()): string {
  return newPostId(atMs);
}

/** 16 lowercase-hex chars — audit session ids, explicitly not a LinkedIn shape. */
export function newHexId(): string {
  return randomBytes(8).toString("hex");
}
