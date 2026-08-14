import { methodNotFound } from "@/lib/googleads/errors";
import { resourceNameFor } from "@/lib/googleads/resources";
import { handleGoogleAds, json } from "@/lib/googleads/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Google Ads' custom methods carry a `:verb` suffix INSIDE a single path
// segment — `customers:listAccessibleCustomers`, `googleAds:search`. A colon is
// not a portable directory name, so the verb cannot be a folder: it is matched
// by hand out of a dynamic segment instead. The paths on the wire are still
// exactly Google's, which is the only thing an agent can see.
//
// The version is dynamic for a different reason: googleads.googleapis.com serves
// many versions at once, so pinning one would 404 an agent whose docs name a
// different one. handleGoogleAds validates it is /^v\d+$/ and threads it into
// the error `@type`.
//
// This route recognises exactly one collection. Anything else is the gateway's
// 404, because the request never reached the Ads service.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ apiVersion: string; collection: string }> },
) {
  const { apiVersion, collection } = await ctx.params;
  return handleGoogleAds(req, { apiVersion }, ({ customer }) =>
    collection === "customers:listAccessibleCustomers"
      ? json({ resourceNames: [resourceNameFor("customer", customer.id)] })
      : methodNotFound(),
  );
}
