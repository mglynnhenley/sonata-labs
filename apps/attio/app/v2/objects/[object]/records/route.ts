import {
  handleAttio,
  json,
  notImplementedRoute,
  renderRecords,
  requireObject,
  runMutation,
} from "@/lib/attio/route-helpers";
import { badRequestError } from "@/lib/attio/errors";
import { newUuid } from "@/lib/attio/ids";
import { writeValues } from "@/lib/attio/values";
import { getRecordRow, insertRecord } from "@/lib/store/records";
import { listAttributes } from "@/lib/store/objects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /v2/objects/{object}/records — an agent that finds no matching company
// has to create one before it can log anything against it.
export async function POST(req: Request, { params }: { params: Promise<{ object: string }> }) {
  const { object } = await params;
  return handleAttio(req, async (ctx) => {
    const { db } = ctx;
    const obj = requireObject(db, object);
    const body = (await req.json().catch(() => ({}))) as {
      data?: { values?: Record<string, unknown> };
    };
    const values = body.data?.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw badRequestError("Request body must carry data.values as an object of attributes.");
    }
    const endpoint = new URL(req.url).pathname;
    const now = Date.now();
    // The object's first attribute is its display name in Attio's UI, so it is
    // what the audit summary should quote.
    const primarySlug = listAttributes(db, obj.id)[0]?.api_slug;

    const id = runMutation(
      db,
      () => {
        const recordId = newUuid();
        insertRecord(db, {
          id: recordId,
          objectId: obj.id,
          createdAtMs: now,
        });
        const changes = writeValues(
          db,
          { recordId, objectId: obj.id, objectSlug: obj.api_slug },
          values,
          { atMs: now, actor: ctx.actor, mode: "create" },
        );
        const primary = changes.find((c) => c.slug === primarySlug);
        return { recordId, name: primary?.after ?? recordId };
      },
      (result) => ({
        method: "POST",
        endpoint,
        actionType: "recordCreate",
        targetType: "record",
        targetId: result.recordId,
        request: body,
        responseCode: 200,
        summary: `Created ${obj.singular_noun} “${result.name}”`,
      }),
    ).recordId;

    const row = getRecordRow(db, obj.id, id);
    if (!row) throw new Error(`record ${id} vanished after insert`);
    return json({ data: renderRecords(db, ctx, obj, [row])[0] });
  });
}

// Attio's upsert — PUT on the COLLECTION, matching on an attribute rather than
// on an id. Refused in Attio's envelope: without this Next answers a bodyless
// 405 and an SDK's `records.assert` fails with nothing to read.
export const PUT = notImplementedRoute(
  "Upserting a record (PUT) is not implemented in the sandbox; POST /v2/objects/{object}/records/query to find it, then PATCH it or POST a new one.",
);
