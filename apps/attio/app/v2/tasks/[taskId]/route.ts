import {
  handleAttio,
  json,
  notImplementedRoute,
  requireTask,
  runMutation,
} from "@/lib/attio/route-helpers";
import { badRequestError } from "@/lib/attio/errors";
import { shapeTask } from "@/lib/attio/shape";
import { resolveAssignees, resolveLinkedRecords } from "@/lib/attio/task-input";
import {
  assigneesByTask,
  getTaskRow,
  linksByTask,
  updateTask,
  type TaskPatch,
} from "@/lib/store/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /v2/tasks/{task_id} — completing the follow-up or moving its deadline.
// The natural second beat after creating one, and the only way an episode can
// show a task being finished.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;
  return handleAttio(req, async (ctx) => {
    const { db } = ctx;
    const existing = requireTask(db, taskId);
    const body = (await req.json().catch(() => ({}))) as {
      data?: {
        deadline_at?: string | null;
        is_completed?: boolean;
        linked_records?: unknown;
        assignees?: unknown;
      };
    };
    const data = body.data ?? {};

    // Only the keys actually present are touched — everything else on the task
    // has to survive untouched, which is what makes this a patch.
    const patch: TaskPatch = {};
    if ("deadline_at" in data) {
      if (data.deadline_at !== null && typeof data.deadline_at !== "string") {
        throw badRequestError("data.deadline_at must be a string or null.");
      }
      patch.deadlineAt = data.deadline_at ?? null;
    }
    if ("is_completed" in data) {
      if (typeof data.is_completed !== "boolean") {
        throw badRequestError("data.is_completed must be a boolean.");
      }
      patch.isCompleted = data.is_completed;
    }
    if ("linked_records" in data) {
      patch.linkedRecords = resolveLinkedRecords(db, data.linked_records);
    }
    if ("assignees" in data) {
      patch.assignees = resolveAssignees(db, data.assignees);
    }
    if (!Object.keys(patch).length) {
      throw badRequestError(
        "data must carry at least one of deadline_at, is_completed, linked_records, assignees.",
      );
    }

    const label = existing.content_plaintext.slice(0, 60);
    const summary =
      patch.isCompleted === true && existing.is_completed === 0
        ? `Completed task “${label}”`
        : patch.isCompleted === false && existing.is_completed === 1
          ? `Reopened task “${label}”`
          : `Updated task “${label}”: ${Object.keys(patch).join(", ")}`;
    const endpoint = new URL(req.url).pathname;

    runMutation(
      db,
      () => updateTask(db, taskId, patch, Date.now()),
      () => ({
        method: "PATCH",
        endpoint,
        actionType: "taskUpdate",
        targetType: "task",
        targetId: taskId,
        request: body,
        responseCode: 200,
        summary,
      }),
    );

    const row = getTaskRow(db, taskId);
    if (!row) throw new Error(`task ${taskId} vanished after update`);
    return json({
      data: shapeTask(
        ctx,
        row,
        linksByTask(db, [taskId]).get(taskId) ?? [],
        assigneesByTask(db, [taskId]).get(taskId) ?? [],
      ),
    });
  });
}

// Attio declares both of these on this path, and `tasks.get` is the natural call
// straight after `tasks.create` — so they answer in Attio's envelope. A route
// file that exports only PATCH makes Next reply to the others with a bodyless
// 405, which reads to an agent like the whole path is wrong.
export const GET = notImplementedRoute(
  "Reading one task by id is not implemented in the sandbox; list tasks with GET /v2/tasks and narrow with linked_object/linked_record_id.",
);
export const DELETE = notImplementedRoute(
  "Deleting tasks is not implemented in the sandbox; close one with PATCH /v2/tasks/{task_id} {\"data\":{\"is_completed\":true}}.",
);
