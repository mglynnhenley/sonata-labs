import { handleLinkedIn, json } from "@/lib/linkedin/route-helpers";
import { notFoundError } from "@/lib/linkedin/errors";
import { shapeUserInfo } from "@/lib/linkedin/shape";
import { getOwnerMember } from "@/lib/store/members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /v2/userinfo — the OpenID Connect userinfo endpoint, and the first call
// any agent makes: who am I posting as. It hands back the BARE person id in
// `sub`, which the agent turns into `urn:li:person:<sub>` itself, exactly as
// against the real API.
//
// No LinkedIn-Version check: handleLinkedIn skips it because the pathname is not
// under /rest/, which is the same rule LinkedIn applies to its non-versioned
// /v2 base.
//
// No audit row — a read is not the agent's action.
export function GET(req: Request) {
  return handleLinkedIn(req, ({ db }) => {
    const member = getOwnerMember(db);
    // An unseeded database is a 404 in LinkedIn's own wording rather than a 500:
    // "there is nobody here" is a fact about the world, not a broken server.
    if (!member) throw notFoundError("The requested member was not found.");
    return json(shapeUserInfo(member));
  });
}
