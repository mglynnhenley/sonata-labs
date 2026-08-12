import type { Database } from "better-sqlite3";
import type { PostRow } from "../linkedin/shape";

export interface PostInput {
  id: string;
  authorUrn: string;
  commentary: string;
  visibility?: string;
  feedDistribution?: string;
  lifecycleState?: string;
  isReshareDisabled?: boolean;
  commentsState?: string;
  createdMs: number;
  publishedMs?: number | null;
  lastModifiedMs: number;
  /** The passthrough blob (content, contentCallToActionLabel, contentLandingPage). */
  extra?: Record<string, unknown> | null;
  isSandboxCreated?: boolean;
}

export function insertPost(db: Database, input: PostInput): PostRow {
  db.prepare(
    `INSERT INTO posts (id, author_urn, commentary, visibility, feed_distribution, lifecycle_state,
                        is_edited, is_reshare_disabled, comments_state, created_ms, published_ms,
                        last_modified_ms, deleted_ms, raw_json, is_sandbox_created)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    input.id,
    input.authorUrn,
    input.commentary,
    input.visibility ?? "PUBLIC",
    input.feedDistribution ?? "MAIN_FEED",
    input.lifecycleState ?? "PUBLISHED",
    input.isReshareDisabled ? 1 : 0,
    input.commentsState ?? "OPEN",
    input.createdMs,
    input.publishedMs ?? null,
    input.lastModifiedMs,
    input.extra && Object.keys(input.extra).length ? JSON.stringify(input.extra) : null,
    input.isSandboxCreated === false ? 0 : 1,
  );
  const row = getPostRow(db, input.id);
  if (!row) throw new Error(`post ${input.id} vanished after insert`);
  return row;
}

/** Returns tombstoned rows too — the judge needs to see what was destroyed. */
export function getPostRow(db: Database, id: string): PostRow | null {
  return (db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRow) ?? null;
}

/** What the API is allowed to serve: everything the DELETE has not tombstoned. */
export function getLivePostRow(db: Database, id: string): PostRow | null {
  return (
    (db
      .prepare("SELECT * FROM posts WHERE id = ? AND deleted_ms IS NULL")
      .get(id) as PostRow) ?? null
  );
}

export interface AuthorQuery {
  authorUrn: string;
  sortBy: "LAST_MODIFIED" | "CREATED";
  includeDrafts: boolean;
  start: number;
  count: number;
}

/**
 * The author finder. Fetches one row past the page so the route knows whether a
 * `next` link is warranted; no total, because LinkedIn's posts finder does not
 * return one.
 */
export function listPostsByAuthor(
  db: Database,
  q: AuthorQuery,
): { rows: PostRow[]; hasMore: boolean } {
  // Only ever these two orderings, and each has its own covering index — the
  // sortBy parameter picks between them and nothing else.
  const order = q.sortBy === "CREATED" ? "created_ms DESC" : "last_modified_ms DESC";
  const draftClause = q.includeDrafts ? "" : "AND lifecycle_state <> 'DRAFT'";
  const rows = db
    .prepare(
      `SELECT * FROM posts
       WHERE author_urn = ? AND deleted_ms IS NULL ${draftClause}
       ORDER BY ${order}, id DESC LIMIT ? OFFSET ?`,
    )
    .all(q.authorUrn, q.count + 1, q.start) as PostRow[];
  return { rows: rows.slice(0, q.count), hasMore: rows.length > q.count };
}

export interface PostPatch {
  commentary?: string;
  lifecycleState?: string;
  publishedMs?: number;
  isEdited?: boolean;
  lastModifiedMs: number;
  extra?: Record<string, unknown>;
}

export function updatePost(db: Database, id: string, patch: PostPatch): PostRow {
  const sets: string[] = ["last_modified_ms = @lastModifiedMs"];
  const params: Record<string, unknown> = { id, lastModifiedMs: patch.lastModifiedMs };
  if (patch.commentary !== undefined) {
    sets.push("commentary = @commentary");
    params.commentary = patch.commentary;
  }
  if (patch.lifecycleState !== undefined) {
    sets.push("lifecycle_state = @lifecycleState");
    params.lifecycleState = patch.lifecycleState;
  }
  if (patch.publishedMs !== undefined) {
    sets.push("published_ms = @publishedMs");
    params.publishedMs = patch.publishedMs;
  }
  if (patch.isEdited !== undefined) {
    sets.push("is_edited = @isEdited");
    params.isEdited = patch.isEdited ? 1 : 0;
  }
  if (patch.extra !== undefined) {
    sets.push("raw_json = @rawJson");
    params.rawJson = Object.keys(patch.extra).length ? JSON.stringify(patch.extra) : null;
  }
  db.prepare(`UPDATE posts SET ${sets.join(", ")} WHERE id = @id`).run(params);
  const row = getPostRow(db, id);
  if (!row) throw new Error(`post ${id} vanished after update`);
  return row;
}

/**
 * Tombstone rather than delete: the API stops serving the post, but the judge
 * can still see that the agent destroyed the company's post. Returns false when
 * the row was already tombstoned, which is what lets DELETE stay idempotent
 * (LinkedIn's documented behaviour) without writing a second audit row saying
 * the agent deleted two things.
 */
export function tombstonePost(db: Database, id: string, atMs: number): boolean {
  const res = db
    .prepare("UPDATE posts SET deleted_ms = ? WHERE id = ? AND deleted_ms IS NULL")
    .run(atMs, id);
  return res.changes > 0;
}

export function countPosts(db: Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM posts WHERE deleted_ms IS NULL").get() as { n: number }
  ).n;
}
