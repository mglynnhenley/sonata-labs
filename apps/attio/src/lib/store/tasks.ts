import type { Database } from "better-sqlite3";
import type { TaskAssigneeRow, TaskLinkRow, TaskRow } from "../attio/shape";

// Tasks and their two side tables. Links and assignees live in their own tables
// because both are filtered on — `?linked_record_id=` answers "what is
// outstanding on this deal", which has to be an indexed lookup and not a scan
// through a JSON column.

/** The four values Attio's `sort` param takes, mapped to a SQL ORDER BY. */
const SORTS: Record<string, string> = {
  "created_at:asc": "created_at_ms ASC, id ASC",
  "created_at:desc": "created_at_ms DESC, id DESC",
  "completed_at:asc": "completed_at_ms ASC, id ASC",
  "completed_at:desc": "completed_at_ms DESC, id DESC",
};

export const TASK_SORTS = Object.keys(SORTS);

export function isTaskSort(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(SORTS, value);
}

export interface TaskQuery {
  limit: number;
  offset: number;
  sort: string;
  linkedObject?: string;
  linkedRecordId?: string;
  /** A workspace-member id or email; the literal "null" selects unassigned tasks. */
  assignee?: string;
  isCompleted?: boolean;
}

export function listTaskRows(db: Database, q: TaskQuery): TaskRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (q.linkedObject || q.linkedRecordId) {
    const link: string[] = ["l.task_id = t.id"];
    if (q.linkedObject) {
      link.push("l.target_object = ?");
      params.push(q.linkedObject);
    }
    if (q.linkedRecordId) {
      link.push("l.target_record_id = ?");
      params.push(q.linkedRecordId);
    }
    clauses.push(`EXISTS (SELECT 1 FROM task_linked_records l WHERE ${link.join(" AND ")})`);
  }

  if (q.assignee !== undefined) {
    if (q.assignee === "" || q.assignee === "null") {
      clauses.push("NOT EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id)");
    } else {
      // An email and an id are both accepted, so the join resolves through
      // workspace_members rather than matching actor_id alone.
      clauses.push(
        `EXISTS (SELECT 1 FROM task_assignees a
                   JOIN workspace_members m ON m.id = a.actor_id
                  WHERE a.task_id = t.id AND (m.id = ? OR m.email_address = ? COLLATE NOCASE))`,
      );
      params.push(q.assignee, q.assignee);
    }
  }

  if (q.isCompleted !== undefined) {
    clauses.push("t.is_completed = ?");
    params.push(q.isCompleted ? 1 : 0);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(`SELECT t.* FROM tasks t ${where} ORDER BY ${SORTS[q.sort]} LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as TaskRow[];
}

export function getTaskRow(db: Database, id: string): TaskRow | null {
  return (db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow) ?? null;
}

export interface TaskInput {
  id: string;
  contentPlaintext: string;
  deadlineAt: string | null;
  isCompleted: boolean;
  completedAtMs: number | null;
  actorType: string;
  actorId: string | null;
  createdAtMs: number;
  linkedRecords: Array<{ targetObject: string; targetRecordId: string }>;
  assignees: Array<{ actorType: string; actorId: string }>;
}

export function insertTask(db: Database, input: TaskInput): void {
  db.prepare(
    `INSERT INTO tasks
       (id, content_plaintext, deadline_at, is_completed, completed_at_ms,
        created_by_actor_type, created_by_actor_id, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.contentPlaintext,
    input.deadlineAt,
    input.isCompleted ? 1 : 0,
    input.completedAtMs,
    input.actorType,
    input.actorId,
    input.createdAtMs,
  );
  replaceLinks(db, input.id, input.linkedRecords);
  replaceAssignees(db, input.id, input.assignees);
}

export function replaceLinks(
  db: Database,
  taskId: string,
  links: Array<{ targetObject: string; targetRecordId: string }>,
): void {
  db.prepare("DELETE FROM task_linked_records WHERE task_id = ?").run(taskId);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO task_linked_records (task_id, target_object, target_record_id, pos)
     VALUES (?, ?, ?, ?)`,
  );
  links.forEach((l, i) => stmt.run(taskId, l.targetObject, l.targetRecordId, i));
}

export function replaceAssignees(
  db: Database,
  taskId: string,
  assignees: Array<{ actorType: string; actorId: string }>,
): void {
  db.prepare("DELETE FROM task_assignees WHERE task_id = ?").run(taskId);
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO task_assignees (task_id, actor_type, actor_id, pos) VALUES (?, ?, ?, ?)",
  );
  assignees.forEach((a, i) => stmt.run(taskId, a.actorType, a.actorId, i));
}

export interface TaskPatch {
  deadlineAt?: string | null;
  isCompleted?: boolean;
  linkedRecords?: Array<{ targetObject: string; targetRecordId: string }>;
  assignees?: Array<{ actorType: string; actorId: string }>;
}

/**
 * Only the keys present are touched — PATCH on a task really is a patch. Flipping
 * `is_completed` stamps or clears `completed_at_ms`, because Attio derives that
 * timestamp rather than taking it from the caller.
 */
export function updateTask(db: Database, id: string, patch: TaskPatch, atMs: number): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.deadlineAt !== undefined) {
    sets.push("deadline_at = ?");
    params.push(patch.deadlineAt);
  }
  if (patch.isCompleted !== undefined) {
    sets.push("is_completed = ?", "completed_at_ms = ?");
    params.push(patch.isCompleted ? 1 : 0, patch.isCompleted ? atMs : null);
  }
  if (sets.length) {
    db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  }
  if (patch.linkedRecords) replaceLinks(db, id, patch.linkedRecords);
  if (patch.assignees) replaceAssignees(db, id, patch.assignees);
}

export function linksByTask(db: Database, taskIds: string[]): Map<string, TaskLinkRow[]> {
  const out = new Map<string, TaskLinkRow[]>();
  if (!taskIds.length) return out;
  const holes = taskIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT * FROM task_linked_records WHERE task_id IN (${holes}) ORDER BY pos, target_record_id`,
    )
    .all(...taskIds) as TaskLinkRow[];
  for (const row of rows) {
    const list = out.get(row.task_id);
    if (list) list.push(row);
    else out.set(row.task_id, [row]);
  }
  return out;
}

export function assigneesByTask(
  db: Database,
  taskIds: string[],
): Map<string, TaskAssigneeRow[]> {
  const out = new Map<string, TaskAssigneeRow[]>();
  if (!taskIds.length) return out;
  const holes = taskIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM task_assignees WHERE task_id IN (${holes}) ORDER BY pos, actor_id`)
    .all(...taskIds) as TaskAssigneeRow[];
  for (const row of rows) {
    const list = out.get(row.task_id);
    if (list) list.push(row);
    else out.set(row.task_id, [row]);
  }
  return out;
}

export function countTasks(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
}
