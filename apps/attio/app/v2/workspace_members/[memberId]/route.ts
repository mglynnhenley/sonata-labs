import { handleAttio, json, requireMember } from "@/lib/attio/route-helpers";
import { shapeMember } from "@/lib/attio/shape";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /v2/workspace_members/{workspace_member_id} — resolve one actor id to the
// human behind it, which is the lookup an agent does after reading a deal owner.
export async function GET(req: Request, { params }: { params: Promise<{ memberId: string }> }) {
  const { memberId } = await params;
  return handleAttio(req, (ctx) => json({ data: shapeMember(ctx, requireMember(ctx.db, memberId)) }));
}
