import type { Database } from "better-sqlite3";
import type { AttributeValueRow, RecordRow } from "../attio/shape";

export function getRecordRow(
  db: Database,
  objectId: string,
  recordId: string,
): RecordRow | null {
  return (
    (db
      .prepare("SELECT * FROM records WHERE object_id = ? AND id = ?")
      .get(objectId, recordId) as RecordRow) ?? null
  );
}

export interface RecordInput {
  id: string;
  objectId: string;
  createdAtMs: number;
  isSandboxCreated?: boolean;
}

export function insertRecord(db: Database, input: RecordInput): void {
  db.prepare(
    "INSERT INTO records (id, object_id, created_at_ms, is_sandbox_created) VALUES (?, ?, ?, ?)",
  ).run(input.id, input.objectId, input.createdAtMs, input.isSandboxCreated ? 1 : 0);
}

export interface RecordQuery {
  objectId: string;
  where: string;
  params: unknown[];
  orderBy: string;
  orderParams: unknown[];
  limit: number;
  offset: number;
}

export function queryRecordRows(db: Database, q: RecordQuery): RecordRow[] {
  return db
    .prepare(
      `SELECT r.* FROM records r
        WHERE r.object_id = ? ${q.where ? `AND ${q.where}` : ""}
        ORDER BY ${q.orderBy}
        LIMIT ? OFFSET ?`,
    )
    .all(q.objectId, ...q.params, ...q.orderParams, q.limit, q.offset) as RecordRow[];
}

/**
 * The currently-active values for a whole page of records in one query. Fetching
 * them per record is the N+1 that turns a 500-row page into 501 statements.
 */
export function activeValuesFor(
  db: Database,
  recordIds: string[],
): Map<string, AttributeValueRow[]> {
  const byRecord = new Map<string, AttributeValueRow[]>();
  if (!recordIds.length) return byRecord;
  const holes = recordIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT * FROM attribute_values
        WHERE record_id IN (${holes}) AND active_until_ms IS NULL
        ORDER BY pos, id`,
    )
    .all(...recordIds) as AttributeValueRow[];
  for (const row of rows) {
    const list = byRecord.get(row.record_id);
    if (list) list.push(row);
    else byRecord.set(row.record_id, [row]);
  }
  return byRecord;
}

/** Including superseded rows — the history the versioned model exists to keep. */
export function allValuesFor(db: Database, recordId: string): AttributeValueRow[] {
  return db
    .prepare(
      "SELECT * FROM attribute_values WHERE record_id = ? ORDER BY attribute_id, active_from_ms, id",
    )
    .all(recordId) as AttributeValueRow[];
}

/**
 * Find a record by the text form of one of its values — how the
 * record-reference shorthands (`"northwind.example"`, `"ana@northwind.example"`)
 * resolve to a real record, and how the seed checks its own references.
 */
export function findRecordByValue(
  db: Database,
  objectId: string,
  attributeSlug: string,
  textValue: string,
): RecordRow | null {
  return (
    (db
      .prepare(
        `SELECT r.* FROM records r
           JOIN attribute_values v ON v.record_id = r.id AND v.active_until_ms IS NULL
           JOIN attributes a ON a.id = v.attribute_id
          WHERE r.object_id = ? AND a.api_slug = ? AND v.text_value = ? COLLATE NOCASE
          LIMIT 1`,
      )
      .get(objectId, attributeSlug, textValue) as RecordRow) ?? null
  );
}

export function countRecords(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM records").get() as { n: number }).n;
}
