import type { Database } from "better-sqlite3";
import { isUuid } from "../attio/ids";
import type { AttributeRow, ObjectRow, StatusRow } from "../attio/shape";

// The schema registry: objects, their attributes and the status options a
// status attribute is allowed to take. Read on every request, written only by
// the two seeders.

export function listObjects(db: Database): ObjectRow[] {
  return db.prepare("SELECT * FROM objects ORDER BY pos, api_slug").all() as ObjectRow[];
}

export function getObjectBySlug(db: Database, slug: string): ObjectRow | null {
  return (
    (db.prepare("SELECT * FROM objects WHERE api_slug = ?").get(slug) as ObjectRow) ?? null
  );
}

/**
 * `{object}` in a path is an api_slug OR an object_id. The shape of the segment
 * picks which lookup to try first, and the other is still tried after — a slug
 * that happens to be UUID-shaped is legal in Attio and would otherwise 404.
 */
export function resolveObject(db: Database, slugOrId: string): ObjectRow | null {
  const byId = () =>
    (db.prepare("SELECT * FROM objects WHERE id = ?").get(slugOrId) as ObjectRow) ?? null;
  if (isUuid(slugOrId)) return byId() ?? getObjectBySlug(db, slugOrId);
  return getObjectBySlug(db, slugOrId) ?? byId();
}

export interface ObjectInput {
  id: string;
  apiSlug: string;
  singularNoun: string;
  pluralNoun: string;
  createdAtMs: number;
  pos?: number;
}

export function insertObject(db: Database, input: ObjectInput): void {
  db.prepare(
    `INSERT INTO objects (id, api_slug, singular_noun, plural_noun, created_at_ms, pos)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.apiSlug,
    input.singularNoun,
    input.pluralNoun,
    input.createdAtMs,
    input.pos ?? 0,
  );
}

export function listAttributes(db: Database, objectId: string): AttributeRow[] {
  return db
    .prepare("SELECT * FROM attributes WHERE object_id = ? ORDER BY pos, api_slug")
    .all(objectId) as AttributeRow[];
}

export function getAttribute(
  db: Database,
  objectId: string,
  slugOrId: string,
): AttributeRow | null {
  return (
    (db
      .prepare("SELECT * FROM attributes WHERE object_id = ? AND (api_slug = ? OR id = ?)")
      .get(objectId, slugOrId, slugOrId) as AttributeRow) ?? null
  );
}

export interface AttributeInput {
  id: string;
  objectId: string;
  apiSlug: string;
  title: string;
  type: string;
  isMultiselect?: boolean;
  currencyCode?: string | null;
  pos?: number;
  createdAtMs: number;
}

export function insertAttribute(db: Database, input: AttributeInput): void {
  db.prepare(
    `INSERT INTO attributes
       (id, object_id, api_slug, title, type, is_multiselect, currency_code, pos, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.objectId,
    input.apiSlug,
    input.title,
    input.type,
    input.isMultiselect ? 1 : 0,
    input.currencyCode ?? null,
    input.pos ?? 0,
    input.createdAtMs,
  );
}

export function listStatuses(db: Database, attributeId: string): StatusRow[] {
  return db
    .prepare("SELECT * FROM statuses WHERE attribute_id = ? ORDER BY pos")
    .all(attributeId) as StatusRow[];
}

/**
 * Every status option for a set of attributes in ONE query, keyed by status id.
 * Shaping a page of deals needs the option behind each stage value; looking each
 * one up separately is the N+1 between a page load and a stall.
 */
export function statusesByAttribute(
  db: Database,
  attributeIds: string[],
): Map<string, StatusRow> {
  if (!attributeIds.length) return new Map();
  const holes = attributeIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM statuses WHERE attribute_id IN (${holes})`)
    .all(...attributeIds) as StatusRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

export function resolveStatus(
  db: Database,
  attributeId: string,
  titleOrId: string,
): StatusRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM statuses WHERE attribute_id = ? AND (id = ? OR title = ? COLLATE NOCASE)",
      )
      .get(attributeId, titleOrId, titleOrId) as StatusRow) ?? null
  );
}

export interface StatusInput {
  id: string;
  attributeId: string;
  title: string;
  isArchived?: boolean;
  celebrationEnabled?: boolean;
  targetTimeInStatus?: string | null;
  pos?: number;
}

export function insertStatus(db: Database, input: StatusInput): void {
  db.prepare(
    `INSERT INTO statuses
       (id, attribute_id, title, is_archived, celebration_enabled, target_time_in_status, pos)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.attributeId,
    input.title,
    input.isArchived ? 1 : 0,
    input.celebrationEnabled ? 1 : 0,
    input.targetTimeInStatus ?? null,
    input.pos ?? 0,
  );
}
