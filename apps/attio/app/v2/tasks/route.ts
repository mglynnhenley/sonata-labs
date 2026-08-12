import { handleAttio, json, runMutation } from "@/lib/attio/route-helpers";
import { badRequestError } from "@/lib/attio/errors";
import { newUuid } from "@/lib/attio/ids";
import { clampLimit, parseOffset } from "@/lib/attio/pagination";
import { shapeTask } from "@/lib/attio/shape";
import { resolveAssignees, resolveLinkedRecords } from "@/lib/attio/task-input";
import {
  assigneesByTask,
  getTaskRow,
  insertTask,
  isTaskSort,
  linksByTask,
  listTaskRows,
  TASK_SORTS,
} from "@/lib/store/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Attio caps a task at 2000 characters. */
const MAX_CONTENT = 2000;

// GET is the owner's open follow-ups; POST is "create a follow-up task", the
// third headline write.

export function GET(req: Request) {
  return handleAttio(req, (ctx) => {
    const sp = new URL(req.url).searchParams;
    const sort = sp.get("sort") || "created_at:asc";
    if (!isTaskSort(sort)) {
      throw badRequestError(
        `Unknown sort "${sort}". Allowed: ${TASK_SORTS.join(", ")}.`,
      );
    }
    const isCompleted = sp.get("is_completed");
    const rows = listTaskRows(ctx.db, {
      limit: clampLimit(sp.get("limit"), 500, 1000),
      offset: parseOffset(sp.get("offset")),
      sort,
      linkedObject: sp.get("linked_object") || undefined,
      linkedRecordId: sp.get("linked_record_id") || undefined,
      // An `assignee` present but empty (or the literal "null") selects the
      // unassigned tasks, which is a different question from not filtering.
      assignee: sp.has("assignee") ? (sp.get("assignee") ?? "") : undefined,
      isCompleted: isCompleted === null ? undefined : isCompleted === "true",
    });
    const ids = rows.map((r) => r.id);
    const links = linksByTask(ctx.db, ids);
    const assignees = assigneesByTask(ctx.db, ids);
    return json({
      data: rows.map((row) =>
        shapeTask(ctx, row, links.get(row.id) ?? [], assignees.get(row.id) ?? []),
      ),
    });
  });
}

export function POST(req: Request) {
  return handleAttio(req, async (ctx) => {
    const { db } = ctx;
    const body = (await req.json().catch(() => ({}))) as {
      data?: {
        content?: string;
        format?: string;
        deadline_at?: string | null;
        is_completed?: boolean;
        linked_records?: unknown;
        assignees?: unknown;
      };
    };
    const data = body.data ?? {};
    if (typeof data.content !== "string" || !data.content.trim()) {
      throw badRequestError("data.content is required.");
    }
    if (data.content.length > MAX_CONTENT) {
      throw badRequestError(`data.content must be at most ${MAX_CONTENT} characters.`);
    }
    if (data.format !== undefined && data.format !== "plaintext") {
      throw badRequestError(`data.format must be "plaintext", got "${data.format}".`);
    }
    const linkedRecords = resolveLinkedRecords(db, data.linked_records);
    const assignees = resolveAssignees(db, data.assignees);
    const now = Date.now();
    const isCompleted = data.is_completed === true;
    const endpoint = new URL(req.url).pathname;
    const content = data.content;
    // Echoed back exactly as sent: Attio never reformats a deadline, so storing
    // the caller's own string is the only lossless thing to do.
    const deadlineAt = data.deadline_at ?? null;

    const id = runMutation(
      db,
      () => {
        const taskId = newUuid();
        insertTask(db, {
          id: taskId,
          contentPlaintext: content,
          deadlineAt,
          isCompleted,
          completedAtMs: isCompleted ? now : null,
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
          createdAtMs: now,
          isSandboxCreated: true,
          linkedRecords,
          assignees,
        });
        return taskId;
      },
      (taskId) => ({
        method: "POST",
        endpoint,
        actionType: "taskCreate",
        targetType: "task",
        targetId: taskId,
        request: body,
        responseCode: 200,
        summary:
          `Created task “${content.slice(0, 60)}”` + (deadlineAt ? ` due ${deadlineAt}` : ""),
      }),
    );

    const row = getTaskRow(db, id);
    if (!row) throw new Error(`task ${id} vanished after insert`);
    return json({
      data: shapeTask(
        ctx,
        row,
        linksByTask(db, [id]).get(id) ?? [],
        assigneesByTask(db, [id]).get(id) ?? [],
      ),
    });
  });
}
