import type { Database } from "better-sqlite3";
import type { GmailLabel, LabelRow } from "../gmail/types";
import { userLabelId } from "../gmail/ids";
import { GmailError } from "../gmail/errors";

export function getLabelRow(db: Database, id: string): LabelRow | null {
  return (db.prepare("SELECT * FROM labels WHERE id = ?").get(id) as LabelRow) ?? null;
}

export function labelExists(db: Database, id: string): boolean {
  return !!db.prepare("SELECT 1 FROM labels WHERE id = ?").get(id);
}

export function listLabelRows(db: Database): LabelRow[] {
  return db
    .prepare("SELECT * FROM labels ORDER BY type DESC, name COLLATE NOCASE")
    .all() as LabelRow[];
}

/** Case-insensitive resolve by name (used by search `label:`/`in:`). */
export function resolveLabelByName(db: Database, name: string): LabelRow | null {
  return (
    (db
      .prepare("SELECT * FROM labels WHERE name = ? COLLATE NOCASE")
      .get(name) as LabelRow) ?? null
  );
}

/** Shape without counts (labels.list). */
export function shapeLabel(row: LabelRow): GmailLabel {
  const label: GmailLabel = {
    id: row.id,
    name: row.name,
    type: row.type,
    messageListVisibility: row.message_list_visibility ?? undefined,
    labelListVisibility: row.label_list_visibility ?? undefined,
  };
  if (row.color_json) label.color = JSON.parse(row.color_json);
  return label;
}

export interface LabelCounts {
  messagesTotal: number;
  messagesUnread: number;
  threadsTotal: number;
  threadsUnread: number;
}

export function computeLabelCounts(db: Database, labelId: string): LabelCounts {
  const messagesTotal = (
    db
      .prepare("SELECT COUNT(*) AS n FROM message_labels WHERE label_id = ?")
      .get(labelId) as { n: number }
  ).n;

  const messagesUnread = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM message_labels ml
         WHERE ml.label_id = ?
           AND EXISTS (SELECT 1 FROM message_labels u WHERE u.message_id = ml.message_id AND u.label_id = 'UNREAD')`,
      )
      .get(labelId) as { n: number }
  ).n;

  const threadsTotal = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT m.thread_id) AS n FROM message_labels ml
         JOIN messages m ON m.id = ml.message_id WHERE ml.label_id = ?`,
      )
      .get(labelId) as { n: number }
  ).n;

  const threadsUnread = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT m.thread_id) AS n FROM message_labels ml
         JOIN messages m ON m.id = ml.message_id
         WHERE ml.label_id = ?
           AND EXISTS (SELECT 1 FROM message_labels u WHERE u.message_id = ml.message_id AND u.label_id = 'UNREAD')`,
      )
      .get(labelId) as { n: number }
  ).n;

  return { messagesTotal, messagesUnread, threadsTotal, threadsUnread };
}

/** Shape with live counts (labels.get). */
export function shapeLabelWithCounts(db: Database, row: LabelRow): GmailLabel {
  return { ...shapeLabel(row), ...computeLabelCounts(db, row.id) };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface CreateLabelInput {
  name: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
  color?: unknown;
}

function nextUserLabelId(db: Database): string {
  const rows = db
    .prepare("SELECT id FROM labels WHERE id LIKE 'Label_%'")
    .all() as { id: string }[];
  let max = 0;
  for (const r of rows) {
    const n = Number(r.id.slice("Label_".length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return userLabelId(max + 1);
}

export function createLabel(db: Database, input: CreateLabelInput): LabelRow {
  if (!input.name || !input.name.trim()) {
    throw new GmailError(400, "Invalid label: missing name.", "invalidArgument");
  }
  if (resolveLabelByName(db, input.name)) {
    throw new GmailError(409, "Label name exists or conflicts", "duplicate", "ALREADY_EXISTS");
  }
  const id = nextUserLabelId(db);
  db.prepare(
    `INSERT INTO labels (id, name, type, message_list_visibility, label_list_visibility, color_json)
     VALUES (?, ?, 'user', ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.messageListVisibility ?? "show",
    input.labelListVisibility ?? "labelShow",
    input.color ? JSON.stringify(input.color) : null,
  );
  return getLabelRow(db, id)!;
}

export function updateLabel(
  db: Database,
  id: string,
  patch: Partial<CreateLabelInput>,
): LabelRow {
  const row = getLabelRow(db, id);
  if (!row) throw new GmailError(404, "Label not found", "notFound", "NOT_FOUND");
  if (row.type === "system") {
    throw new GmailError(400, "Cannot modify a system label.", "invalidArgument");
  }
  const name = patch.name ?? row.name;
  if (patch.name && patch.name !== row.name) {
    const clash = resolveLabelByName(db, patch.name);
    if (clash && clash.id !== id) {
      throw new GmailError(409, "Label name exists or conflicts", "duplicate", "ALREADY_EXISTS");
    }
  }
  db.prepare(
    `UPDATE labels SET name = ?, message_list_visibility = ?, label_list_visibility = ?, color_json = ? WHERE id = ?`,
  ).run(
    name,
    patch.messageListVisibility ?? row.message_list_visibility,
    patch.labelListVisibility ?? row.label_list_visibility,
    patch.color !== undefined
      ? patch.color
        ? JSON.stringify(patch.color)
        : null
      : row.color_json,
    id,
  );
  return getLabelRow(db, id)!;
}

export function deleteLabel(db: Database, id: string): void {
  const row = getLabelRow(db, id);
  if (!row) throw new GmailError(404, "Label not found", "notFound", "NOT_FOUND");
  if (row.type === "system") {
    throw new GmailError(400, "Cannot delete a system label.", "invalidArgument");
  }
  db.prepare("DELETE FROM message_labels WHERE label_id = ?").run(id);
  db.prepare("DELETE FROM labels WHERE id = ?").run(id);
}
