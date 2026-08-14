import { handleLinkedIn, json } from "@/lib/linkedin/route-helpers";
import { badRequestError, missingFieldError } from "@/lib/linkedin/errors";
import { buildPaging, clampCount, nextHref, parseStart } from "@/lib/linkedin/paging";
import { shapeAcl } from "@/lib/linkedin/shape";
import { parseUrn } from "@/lib/linkedin/urn";
import { listAclsForMember, listAclsForOrganization } from "@/lib/store/organizations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /rest/organizationAcls — how an agent discovers WHICH company page it may
// post as. Without it, "read the company's recent posts" needs a hardcoded
// organization URN and the `author` on a create is guesswork.
//
// No paging.total: LinkedIn's own organizationAcls samples do not carry one, and
// an agent that learns to read it here would find it undefined against the real
// API.
export function GET(req: Request) {
  return handleLinkedIn(req, ({ db, ownerMemberId }) => {
    const url = new URL(req.url);
    const sp = url.searchParams;
    const q = sp.get("q");
    const start = parseStart(sp.get("start"));
    const count = clampCount(sp.get("count"));
    const filters = {
      role: sp.get("role") || undefined,
      state: sp.get("state") || undefined,
      start,
      count,
    };

    let page;
    if (q === "roleAssignee") {
      // The finder is scoped to the authenticated member — LinkedIn derives the
      // assignee from the token rather than taking it as a parameter.
      page = listAclsForMember(db, ownerMemberId, filters);
    } else if (q === "organization") {
      const organization = sp.get("organization");
      if (!organization) throw missingFieldError("organization");
      const parsed = parseUrn(organization);
      if (!parsed || parsed.kind !== "organization") {
        throw badRequestError("Invalid query parameters passed to request");
      }
      page = listAclsForOrganization(db, parsed.id, filters);
    } else {
      // LinkedIn's own wording for a malformed finder.
      throw badRequestError("Invalid query parameters passed to request");
    }

    return json({
      elements: page.rows.map(shapeAcl),
      paging: buildPaging({
        start,
        count,
        hasMore: page.hasMore,
        nextHref: nextHref(url.pathname, sp, start + count),
      }),
    });
  });
}
