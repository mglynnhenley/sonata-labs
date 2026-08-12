import { handleAttio, json } from "@/lib/attio/route-helpers";
import { shapeMember } from "@/lib/attio/shape";
import { listMembers } from "@/lib/store/members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /v2/workspace_members — how an actor becomes a person.
//
// A deal's owner, every created_by_actor and every task assignee is a
// `{referenced_actor_type, referenced_actor_id}` pair, so without this endpoint
// "who owns the Northwind renewal?" answers with a UUID and stops there. Attio
// returns the whole list; there is no pagination on it.
export function GET(req: Request) {
  return handleAttio(req, (ctx) => json({ data: listMembers(ctx.db).map((row) => shapeMember(ctx, row)) }));
}
