import { checkAuth } from "@/lib/gmail/auth";
import { notImplemented } from "@/lib/gmail/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// history.list is out of scope (historyId numbers are still maintained
// monotonically). Return a Gmail-shaped 501 rather than a fake result.
export async function GET(req: Request) {
  const authErr = checkAuth(req);
  if (authErr) return authErr;
  return notImplemented("history.list is not implemented in the sandbox.");
}
