import { handleLinkedIn, json } from "@/lib/linkedin/route-helpers";
import { notFoundError } from "@/lib/linkedin/errors";
import { shapeOrganization } from "@/lib/linkedin/shape";
import { getOrganization } from "@/lib/store/organizations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /rest/organizations/{id} — the one lookup that turns the URN
// organizationAcls hands back into a company. Without it an agent told to post
// as the company page cannot confirm WHICH company it is about to post as, and
// cannot connect `urn:li:organization:7412903` to "Acme" — which is the single
// fact that makes this the same business as the inbox and the calendar.
//
// The path segment is the BARE numeric id, not a URN. LinkedIn's own example is
// `/rest/organizations/79988552`, and the response is the one place in this API
// where `id` comes back as a NUMBER rather than a string or a URN.
//
// This is the publicly documented Organization Lookup by id. The partner-gated
// halves — finders by vanity name or email domain, follower statistics, share
// statistics — are not implemented and will not be; see README.md.
export function GET(
  req: Request,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  return handleLinkedIn(req, async ({ db }) => {
    const { organizationId } = await params;
    const row = getOrganization(db, organizationId);
    if (!row) throw notFoundError("The requested organization was not found.");
    return json(shapeOrganization(row));
  });
}
