import type { Database } from "better-sqlite3";
import type { NoteRow } from "../attio/shape";

export function listNoteRows(
  db: Database,
  opts: { parentObject?: string; parentRecordId?: string; limit: number; offset: number },
): NoteRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.parentObject) {
    clauses.push("parent_object = ?");
    params.push(opts.parentObject);
  }
  if (opts.parentRecordId) {
    clauses.push("parent_record_id = ?");
    params.push(opts.parentRecordId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT * FROM notes ${where} ORDER BY created_at_ms DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit, opts.offset) as NoteRow[];
}

export function getNoteRow(db: Database, id: string): NoteRow | null {
  return (db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow) ?? null;
}

export interface NoteInput {
  id: string;
  parentObject: string;
  parentRecordId: string;
  title: string;
  contentPlaintext: string;
  contentMarkdown: string;
  actorType: string;
  actorId: string | null;
  createdAtMs: number;
}

export function insertNote(db: Database, input: NoteInput): void {
  db.prepare(
    `INSERT INTO notes
       (id, parent_object, parent_record_id, title, content_plaintext, content_markdown,
        created_by_actor_type, created_by_actor_id, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.parentObject,
    input.parentRecordId,
    input.title,
    input.contentPlaintext,
    input.contentMarkdown,
    input.actorType,
    input.actorId,
    input.createdAtMs,
  );
}

export function countNotes(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
}

/**
 * Markdown → plaintext, deliberately crude: strip the leading heading, quote and
 * list markers per line and the inline emphasis pairs, and nothing else. An
 * agent reading `content_plaintext` wants the words; a faithful renderer would
 * be a second thing to keep true for no gain.
 */
export function markdownToPlaintext(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+)/, ""))
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\w)[*_`](.+?)[*_`](?!\w)/g, "$1");
}
