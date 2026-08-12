import type { Database } from "better-sqlite3";
import { newHexId } from "./googleads/ids";

// Audit trail. Tables live in audit.db, ATTACHed as `audit` onto the working
// connection (see db.ts), so an audit row commits in the same transaction as the
// mutation it records — and still survives a reset (separate file).

const g = globalThis as unknown as { __googleAdsSandboxSession?: string };

/** Ensure a session exists and return its id (creates one lazily). */
export function getCurrentSessionId(db: Database): string {
  if (g.__googleAdsSandboxSession) {
    // Re-check: a reset starts a new session and the cached id may name a row
    // that no longer exists on the handle we are holding.
    const exists = db
      .prepare("SELECT 1 FROM audit.sessions WHERE id = ?")
      .get(g.__googleAdsSandboxSession);
    if (exists) return g.__googleAdsSandboxSession;
  }
  return startNewSession(db, "session started");
}

export function startNewSession(db: Database, note: string, at?: number): string {
  const id = newHexId();
  db.prepare("INSERT INTO audit.sessions (id, started_at, note) VALUES (?, ?, ?)").run(
    id,
    at ?? Date.now(),
    note,
  );
  g.__googleAdsSandboxSession = id;
  return id;
}

export interface ActionEntry {
  method: string;
  endpoint: string;
  actionType?: string;
  targetType?: string;
  targetId?: string;
  request?: unknown;
  responseCode?: number;
  summary: string;
}

/**
 * Record an action. Call inside the mutation's transaction so it commits
 * atomically with the change. `at` lets tests pin the timestamp.
 */
export function logAction(db: Database, entry: ActionEntry, at?: number): void {
  const sessionId = getCurrentSessionId(db);
  db.prepare(
    `INSERT INTO audit.action_log
       (session_id, ts, method, endpoint, action_type, target_type, target_id, request_json, response_code, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    at ?? Date.now(),
    entry.method,
    entry.endpoint,
    entry.actionType ?? null,
    entry.targetType ?? null,
    entry.targetId ?? null,
    entry.request != null ? JSON.stringify(entry.request) : null,
    entry.responseCode ?? null,
    entry.summary,
  );
}

// --- reads (activity panel) --------------------------------------------------

export interface SessionRow {
  id: string;
  started_at: number;
  note: string | null;
  action_count: number;
}

export function listSessions(db: Database): SessionRow[] {
  return db
    .prepare(
      `SELECT s.id, s.started_at, s.note,
              (SELECT COUNT(*) FROM audit.action_log a WHERE a.session_id = s.id) AS action_count
       FROM audit.sessions s
       ORDER BY s.started_at DESC`,
    )
    .all() as SessionRow[];
}

export interface ActionRow {
  id: number;
  session_id: string;
  ts: number;
  method: string;
  endpoint: string;
  action_type: string | null;
  target_type: string | null;
  target_id: string | null;
  request_json: string | null;
  response_code: number | null;
  summary: string;
}

export function listActions(
  db: Database,
  opts: { sessionId?: string; sinceId?: number; beforeId?: number; limit?: number } = {},
): ActionRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.sessionId) {
    clauses.push("session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts.sinceId) {
    clauses.push("id > ?");
    params.push(opts.sinceId);
  }
  // Rows come back newest-first, so paging further back uses a descending cursor.
  if (opts.beforeId) {
    clauses.push("id < ?");
    params.push(opts.beforeId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM audit.action_log ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, opts.limit ?? 200) as ActionRow[];
}
