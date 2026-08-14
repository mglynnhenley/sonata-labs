import { randomBytes, randomUUID } from "node:crypto";

// Attio's record_id, note_id, task_id, object_id, attribute_id, status_id and
// workspace_member_id are all lowercase hyphenated v4 UUIDs, so a sandbox-created
// row is indistinguishable from a seeded one — which is the point: an agent must
// not be able to tell which records it made.

export function newUuid(): string {
  return randomUUID();
}

/** 16 lowercase-hex chars — used for audit session ids, not an Attio shape. */
export function newHexId(): string {
  return randomBytes(8).toString("hex");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a path segment is an id rather than an api_slug. `{object}` accepts
 * either, so the resolver has to decide which lookup to try first.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
