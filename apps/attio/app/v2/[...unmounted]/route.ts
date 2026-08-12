import { checkAuth } from "@/lib/attio/auth";
import { errorResponse } from "@/lib/attio/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The catch-all for the Attio surface this clone does not implement.
//
// Next resolves static and nested-dynamic segments before a catch-all, so this
// only ever answers a path nothing else claimed — and without it those paths
// return Next's HTML 404, which tells an agent nothing and looks nothing like
// Attio. Auth runs first, so an unauthenticated caller still gets the 401 the
// real API would give it rather than learning which paths exist.

const IMPLEMENTED =
  "/v2/self, /v2/workspace_members[/{workspace_member_id}], " +
  "/v2/objects/{object}/records[/query|/{record_id}], /v2/notes, /v2/tasks[/{task_id}]";

async function unmounted(
  req: Request,
  { params }: { params: Promise<{ unmounted: string[] }> },
): Promise<Response> {
  const authErr = checkAuth(req);
  if (authErr) return authErr;
  const { unmounted: segments } = await params;
  return errorResponse(
    404,
    `${req.method} /v2/${segments.join("/")} is not implemented in this sandbox. ` +
      `Implemented: ${IMPLEMENTED}.`,
    "not_found",
  );
}

export const GET = unmounted;
export const POST = unmounted;
export const PATCH = unmounted;
export const PUT = unmounted;
export const DELETE = unmounted;
