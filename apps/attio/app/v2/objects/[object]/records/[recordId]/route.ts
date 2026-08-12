import {
  handleAttio,
  json,
  notImplementedRoute,
  recordDisplayName,
  renderRecords,
  requireObject,
  requireRecord,
  runMutation,
} from "@/lib/attio/route-helpers";
import { badRequestError } from "@/lib/attio/errors";
import { writeValues, type ValueChange } from "@/lib/attio/values";
import { getRecordRow } from "@/lib/store/records";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET reads one record; PATCH is the headline write — "move this deal to Won" —
// and its versioning behaviour is the whole reason this clone exists.

export async function GET(
  req: Request,
  { params }: { params: Promise<{ object: string; recordId: string }> },
) {
  const { object, recordId } = await params;
  return handleAttio(req, (ctx) => {
    const obj = requireObject(ctx.db, object);
    const row = requireRecord(ctx.db, obj.id, recordId);
    return json({ data: renderRecords(ctx.db, ctx, obj, [row])[0] });
  });
}

/**
 * The transition string is generated from the change list rather than
 * hand-written, because it is what a judge reads to decide whether the agent
 * did the thing the episode asked for.
 */
function summarize(name: string, changes: ValueChange[]): string {
  if (changes.length === 1) {
    const change = changes[0];
    const verb = change.slug === "stage" ? "Moved" : "Updated";
    return change.before === null
      ? `${verb} “${name}” ${change.slug}: ${change.after}`
      : `${verb} “${name}” ${change.slug}: ${change.before} → ${change.after}`;
  }
  return `Updated “${name}”: ${changes.map((c) => c.slug).join(", ")}`;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ object: string; recordId: string }> },
) {
  const { object, recordId } = await params;
  return handleAttio(req, async (ctx) => {
    const { db } = ctx;
    const obj = requireObject(db, object);
    requireRecord(db, obj.id, recordId);
    const body = (await req.json().catch(() => ({}))) as {
      data?: { values?: Record<string, unknown> };
    };
    const values = body.data?.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw badRequestError("Request body must carry data.values as an object of attributes.");
    }
    const endpoint = new URL(req.url).pathname;
    const now = Date.now();
    // Read before the write: the summary quotes the name the record had when the
    // agent acted on it.
    const displayName = recordDisplayName(db, obj.id, recordId);

    runMutation(
      db,
      () =>
        // `append` is Attio's PATCH: single-value attributes supersede, and
        // multiselect attributes gain values without losing the ones there.
        writeValues(
          db,
          { recordId, objectId: obj.id, objectSlug: obj.api_slug },
          values,
          { atMs: now, actor: ctx.actor, mode: "append", isSandboxCreated: true },
        ),
      (changes) => ({
        method: "PATCH",
        endpoint,
        actionType: "recordUpdate",
        targetType: "record",
        targetId: recordId,
        request: body,
        responseCode: 200,
        summary: summarize(displayName, changes),
      }),
    );

    const row = getRecordRow(db, obj.id, recordId);
    if (!row) throw new Error(`record ${recordId} vanished after update`);
    return json({ data: renderRecords(db, ctx, obj, [row])[0] });
  });
}

// Attio implements both of these; this sandbox refuses them in Attio's own
// envelope rather than letting Next answer a bodyless 405.
export const PUT = notImplementedRoute(
  "Overwriting values (PUT) is not implemented in the sandbox; PATCH appends multiselect values and supersedes single values.",
);
export const DELETE = notImplementedRoute(
  "Deleting records is not implemented in the sandbox.",
);
