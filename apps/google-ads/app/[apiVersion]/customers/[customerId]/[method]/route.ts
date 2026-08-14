import { methodNotFound, requestError } from "@/lib/googleads/errors";
import { executeGaql, type ExecuteResult } from "@/lib/googleads/gaql/execute";
import { parseGaql } from "@/lib/googleads/gaql/parse";
import { applyOperations, type MutateResource } from "@/lib/googleads/mutate";
import { clampPageSize, decodePageToken, encodePageToken } from "@/lib/googleads/pagination";
import { handleGoogleAds, json, runMutation, type GoogleAdsCtx } from "@/lib/googleads/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The four custom methods on one customer. Reads are NOT audit-logged and
// mutations are, which is the whole reason an assertion can only ever observe
// what the agent CHANGED — a thousand reports leave no trace.

/** The stream's chunk size. Google's is 10000 rows; the seeded account is one chunk. */
const STREAM_CHUNK = 10_000;

interface SearchBody {
  query?: unknown;
  pageToken?: unknown;
  pageSize?: unknown;
  returnTotalResultsCount?: unknown;
  operations?: unknown;
  partialFailure?: unknown;
  validateOnly?: unknown;
}

function requireQuery(body: SearchBody): string {
  if (typeof body.query !== "string" || !body.query.trim()) {
    throw requestError("REQUIRED_FIELD_MISSING", "The request is missing required information.");
  }
  return body.query;
}

function runQuery(ctx: GoogleAdsCtx, query: string): ExecuteResult {
  return executeGaql(ctx.db, parseGaql(query), ctx.customer);
}

function search(ctx: GoogleAdsCtx, body: SearchBody) {
  const { rows, fieldMask, totalCount } = runQuery(ctx, requireQuery(body));
  const offset = decodePageToken(typeof body.pageToken === "string" ? body.pageToken : null).offset;
  const pageSize = clampPageSize(body.pageSize);
  const page = rows.slice(offset, offset + pageSize);

  // proto3 JSON omits an empty repeated field, so a query that matched nothing
  // answers with no `results` key at all. A client that walks `body.results`
  // without checking crashes against the real API, and it has to crash here too
  // or the sandbox is where it learned the habit.
  const payload: Record<string, unknown> = {};
  if (page.length) payload.results = page;
  payload.fieldMask = fieldMask;
  // nextPageToken is present ONLY when another page exists — never null, because
  // a client that loops "while nextPageToken" would never stop.
  if (offset + pageSize < rows.length) {
    payload.nextPageToken = encodePageToken({ offset: offset + pageSize });
  }
  // What the query MATCHED, not what came back: Google defines this as the count
  // ignoring the LIMIT clause, and paging does not narrow it either. int64 on the
  // wire is a string, and this one is no exception.
  if (body.returnTotalResultsCount === true) payload.totalResultsCount = String(totalCount);
  return json(payload);
}

function searchStream(ctx: GoogleAdsCtx, body: SearchBody) {
  // The stream request has no pageSize and no pageToken field to begin with, so
  // sending one is a malformed REQUEST and not a malformed query. A queryError
  // here would point its fieldPath at `query` and send an agent back to
  // re-inspect GAQL that was never wrong. Both codes below are real RequestError
  // members — a code an SDK cannot find in its generated enum is worse than none.
  if (body.pageSize !== undefined) {
    throw requestError(
      "PAGE_SIZE_NOT_SUPPORTED",
      "Setting the page size is not supported. searchStream returns every matching row.",
    );
  }
  if (body.pageToken !== undefined) {
    throw requestError("INVALID_PAGE_TOKEN", "searchStream does not paginate, so it takes no page token.");
  }
  const { rows, fieldMask } = runQuery(ctx, requireQuery(body));
  const chunks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < rows.length; i += STREAM_CHUNK) {
    chunks.push({ results: rows.slice(i, i + STREAM_CHUNK), fieldMask, requestId: ctx.requestId });
  }
  // A stream that matched nothing is still one chunk: the array shape is what a
  // client parses, and an empty array has nothing to read the fieldMask off. The
  // chunk carries no `results` key, for the same reason search's response does
  // not — an empty repeated field is absent in proto3 JSON.
  if (!chunks.length) chunks.push({ fieldMask, requestId: ctx.requestId });
  return json(chunks);
}

function mutate(ctx: GoogleAdsCtx, body: SearchBody, resource: MutateResource) {
  const outcome = runMutation(
    ctx.db,
    () =>
      applyOperations(ctx.db, {
        resource,
        customerId: ctx.customer.id,
        currencyCode: ctx.customer.currency_code,
        apiVersion: ctx.apiVersion,
        operations: body.operations,
        partialFailure: body.partialFailure === true,
        validateOnly: body.validateOnly === true,
        endpoint: ctx.endpoint,
      }),
    // One audit row per APPLIED operation, inside the same transaction as the
    // change — a batch that rolled back leaves none of them behind.
    (result) => result.entries,
  );
  // Empty repeated field, absent key: a validateOnly batch reports only what was
  // wrong, so a clean dry run is the empty object `{}` the real API answers with
  // and not a `results` key an agent could learn to read a resource name off.
  const payload: Record<string, unknown> = {};
  if (outcome.results.length) payload.results = outcome.results;
  if (outcome.partialFailureError) payload.partialFailureError = outcome.partialFailureError;
  return json(payload);
}

export async function POST(
  req: Request,
  routeCtx: { params: Promise<{ apiVersion: string; customerId: string; method: string }> },
) {
  const { apiVersion, customerId, method } = await routeCtx.params;
  const body = (await req.json().catch(() => ({}))) as SearchBody;
  return handleGoogleAds(
    req,
    { apiVersion, customerId, stream: method === "googleAds:searchStream" },
    (ctx) => {
      switch (method) {
        case "googleAds:search":
          return search(ctx, body);
        case "googleAds:searchStream":
          return searchStream(ctx, body);
        case "campaigns:mutate":
          return mutate(ctx, body, "campaign");
        case "campaignBudgets:mutate":
          return mutate(ctx, body, "campaignBudget");
        default:
          return methodNotFound();
      }
    },
  );
}
