import {
  handleAttio,
  json,
  renderRecords,
  requireObject,
} from "@/lib/attio/route-helpers";
import { compileQuery } from "@/lib/attio/filter";
import { clampLimit, parseOffset } from "@/lib/attio/pagination";
import { queryRecordRows } from "@/lib/store/records";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /v2/objects/{object}/records/query — the single most important read:
// "find the company this thread is about" and "list the deals at stage X".
//
// The routing subtlety worth knowing: this static `query` segment is a sibling
// of the dynamic `[recordId]` segment, and Next resolves static before dynamic,
// which is why /v2/objects/people/records/query never falls into the record
// handler. Read-only, so no audit row.
export async function POST(req: Request, { params }: { params: Promise<{ object: string }> }) {
  const { object } = await params;
  return handleAttio(req, async (ctx) => {
    const { db } = ctx;
    const obj = requireObject(db, object);
    const body = (await req.json().catch(() => ({}))) as {
      filter?: unknown;
      sorts?: unknown;
      limit?: number;
      offset?: number;
    };
    const compiled = compileQuery(db, obj.id, body);
    const rows = queryRecordRows(db, {
      objectId: obj.id,
      ...compiled,
      limit: clampLimit(body.limit, 500, 1000),
      offset: parseOffset(body.offset),
    });
    return json({ data: renderRecords(db, ctx, obj, rows) });
  });
}
