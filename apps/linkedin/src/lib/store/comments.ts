import type { Database } from "better-sqlite3";
import type { CommentRow } from "../linkedin/shape";

// The comment thread. The composite comment URN is derived at read time from
// post_id + id (see urn.ts) rather than stored, so it can never drift from the
// row it names.

export interface CommentInput {
  id: string;
  postId: string;
  parentCommentId?: string | null;
  actorUrn: string;
  /** The admin who acted, when actorUrn is a page. Null for a person's comment. */
  agentUrn?: string | null;
  text: string;
  attributes?: unknown[] | null;
  createdMs: number;
  lastModifiedMs?: number;
  isSandboxCreated?: boolean;
}

export function insertComment(db: Database, input: CommentInput): CommentRow {
  db.prepare(
    `INSERT INTO comments (id, post_id, parent_comment_id, actor_urn, agent_urn, message_text,
                           attributes_json, created_ms, last_modified_ms, is_sandbox_created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.postId,
    input.parentCommentId ?? null,
    input.actorUrn,
    input.agentUrn ?? null,
    input.text,
    input.attributes && input.attributes.length ? JSON.stringify(input.attributes) : null,
    input.createdMs,
    input.lastModifiedMs ?? input.createdMs,
    input.isSandboxCreated === false ? 0 : 1,
  );
  const row = getCommentRow(db, input.id);
  if (!row) throw new Error(`comment ${input.id} vanished after insert`);
  return row;
}

export function getCommentRow(db: Database, id: string): CommentRow | null {
  return (db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as CommentRow) ?? null;
}

export interface CommentQuery {
  start: number;
  count: number;
}

// Unlike the posts finder, LinkedIn's socialActions comments finder DOES return
// paging.total, so both of these report one — the total is what an agent uses to
// decide whether a thread is worth reading in full.
function pageComments(
  db: Database,
  where: string,
  params: unknown[],
  q: CommentQuery,
): { rows: CommentRow[]; total: number } {
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE ${where}`).get(...params) as { n: number }
  ).n;
  // Oldest-first: the documented samples are in creation order, and a support
  // thread only reads correctly from the top.
  const rows = db
    .prepare(`SELECT * FROM comments WHERE ${where} ORDER BY created_ms, id LIMIT ? OFFSET ?`)
    .all(...params, q.count, q.start) as CommentRow[];
  return { rows, total };
}

export function listTopLevelComments(
  db: Database,
  postId: string,
  q: CommentQuery,
): { rows: CommentRow[]; total: number } {
  return pageComments(db, "post_id = ? AND parent_comment_id IS NULL", [postId], q);
}

export function listReplies(
  db: Database,
  parentCommentId: string,
  q: CommentQuery,
): { rows: CommentRow[]; total: number } {
  return pageComments(db, "parent_comment_id = ?", [parentCommentId], q);
}

/** The two numbers socialMetadata's commentSummary needs, in one pass. */
export function countCommentsForPost(
  db: Database,
  postId: string,
): { count: number; topLevelCount: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count,
              SUM(CASE WHEN parent_comment_id IS NULL THEN 1 ELSE 0 END) AS top_level
       FROM comments WHERE post_id = ?`,
    )
    .get(postId) as { count: number; top_level: number | null };
  return { count: row.count, topLevelCount: row.top_level ?? 0 };
}

export function countReplies(db: Database, parentCommentId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM comments WHERE parent_comment_id = ?")
      .get(parentCommentId) as { n: number }
  ).n;
}

export function countComments(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;
}
