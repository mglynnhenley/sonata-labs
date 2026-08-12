// Acceptance harness: drive the running sandbox exactly the way Google's own
// REST examples do.
//
//   PORT=3700 npm run smoke
//
// The one honest deviation from the other clones is in the name: there is no SDK
// to point at this twin. Google ships no official Node client for the Ads API
// (Java, .NET, PHP, Python, Ruby and Perl only), so the documented REST
// transport IS the interface, and this script issues those calls with fetch. If
// it passes, an agent working from developers.google.com/google-ads/api/rest
// works against the sandbox unchanged.
//
// Requires a running, seeded server on $PORT. It resets to the snapshot as its
// first act so it is repeatable — never point it at a twin mid-episode.

const PORT = process.env.PORT || "3700";
const ROOT_URL = process.env.SANDBOX_ROOT_URL || `http://localhost:${PORT}`;
const TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";
const DEV_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "sandbox-dev-token";
const API_VERSION = "v17";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail !== undefined) console.log("      detail:", JSON.stringify(detail)?.slice(0, 300));
  }
}

interface Reply {
  status: number;
  body: any;
}

async function ads(
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; method?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
    "developer-token": DEV_TOKEN,
    ...init.headers,
  };
  for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k];
  const res = await fetch(`${ROOT_URL}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** The whole point of a Google-shaped error: the code a client actually reads. */
function errorCodeOf(body: any): Record<string, string> | undefined {
  const envelope = Array.isArray(body) ? body[0] : body;
  return envelope?.error?.details?.[0]?.errors?.[0]?.errorCode;
}

async function expectError(
  name: string,
  reply: Promise<Reply>,
  httpStatus: number,
  codeKey?: string,
  codeValue?: string,
): Promise<void> {
  const { status, body } = await reply;
  if (status !== httpStatus) {
    check(name, false, { got: status, want: httpStatus, body });
    return;
  }
  if (!codeKey) {
    check(name, true);
    return;
  }
  const code = errorCodeOf(body);
  check(name, code?.[codeKey] === codeValue, { got: code, want: { [codeKey]: codeValue } });
}

function search(cid: string, query: string, extra: Record<string, unknown> = {}) {
  return ads(`/${API_VERSION}/customers/${cid}/googleAds:search`, { body: { query, ...extra } });
}

async function main(): Promise<void> {
  console.log(`\n\x1b[1mGoogle Ads sandbox smoke — ${ROOT_URL}\x1b[0m`);

  const reset = await fetch(`${ROOT_URL}/api/sandbox/reset`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sandbox-token": TOKEN },
    body: JSON.stringify({ note: "smoke" }),
  });
  const resetBody = (await reset.json()) as { status?: string; campaigns?: number };
  check("reset restores the snapshot", resetBody.status === "ok" && !!resetBody.campaigns, resetBody);

  // --- reads ---------------------------------------------------------------
  console.log("\n  reads");

  const accessible = await ads(`/${API_VERSION}/customers:listAccessibleCustomers`);
  const resourceNames: string[] = accessible.body?.resourceNames ?? [];
  check(
    "listAccessibleCustomers returns customers/<digits>",
    /^customers\/\d{10}$/.test(resourceNames[0] ?? ""),
    accessible.body,
  );
  const cid = (resourceNames[0] ?? "").split("/")[1];
  if (!cid) throw new Error("no accessible customer — run `npm run seed`");

  const spendQuery =
    "SELECT campaign.name, campaign_budget.amount_micros, metrics.cost_micros, metrics.ctr " +
    "FROM campaign WHERE segments.date DURING LAST_7_DAYS ORDER BY metrics.cost_micros DESC";
  const spend = await search(cid, spendQuery);
  check(
    "fieldMask lists the SELECT fields in order, camelCased",
    spend.body?.fieldMask === "campaign.name,campaignBudget.amountMicros,metrics.costMicros,metrics.ctr",
    spend.body?.fieldMask,
  );

  const top = spend.body?.results?.[0];
  check("the report names the Payments campaign first", top?.campaign?.name?.includes("Payments"), top);
  check(
    "int64 fields cross the wire as JSON strings",
    typeof top?.metrics?.costMicros === "string" && typeof top?.campaignBudget?.amountMicros === "string",
    top,
  );
  check("doubles cross the wire as JSON numbers", typeof top?.metrics?.ctr === "number", top?.metrics);
  check(
    "resourceName is present on every resource, selected or not",
    top?.campaign?.resourceName === `customers/${cid}/campaigns/17204885331` &&
      typeof top?.campaignBudget?.resourceName === "string",
    top,
  );

  const over = (spend.body?.results ?? []).filter(
    (r: any) => Number(r.metrics.costMicros) > Number(r.campaignBudget.amountMicros) * 7,
  );
  check(
    "exactly one campaign is over its seven-day budget",
    over.length === 1 && over[0].campaign.name.includes("Payments"),
    over.map((r: any) => r.campaign.name),
  );

  const metricsOnly = await search(
    cid,
    "SELECT metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS",
  );
  const anonymous: any[] = metricsOnly.body?.results ?? [];
  check(
    "a metrics-only report still names the campaign each row belongs to",
    anonymous.length === 4 &&
      anonymous.every((r) => /^customers\/\d+\/campaigns\/\d+$/.test(r.campaign?.resourceName ?? "")),
    metricsOnly.body,
  );
  check(
    "…while the fieldMask lists only the SELECT, as the real one does",
    metricsOnly.body?.fieldMask === "metrics.clicks",
    metricsOnly.body?.fieldMask,
  );

  const segmented = await search(
    cid,
    "SELECT segments.date, metrics.cost_micros FROM campaign " +
      "WHERE campaign.id = 17204885331 AND segments.date DURING LAST_7_DAYS ORDER BY segments.date ASC",
  );
  const days: any[] = segmented.body?.results ?? [];
  check("segments.date splits one campaign into seven rows", days.length === 7, days.length);
  check(
    "the window is 2026-07-27 … 2026-08-02",
    days[0]?.segments?.date === "2026-07-27" && days[6]?.segments?.date === "2026-08-02",
    days.map((d) => d.segments.date),
  );
  check(
    "the segmented costs sum back to the unsegmented total",
    String(days.reduce((n, d) => n + Number(d.metrics.costMicros), 0)) ===
      spend.body.results.find((r: any) => r.campaign.name.includes("Payments")).metrics.costMicros,
  );

  const attributes = await search(cid, "SELECT campaign.name, campaign.status FROM campaign");
  const named = (rows: any[]) => rows.map((r: any) => r.campaign.name);
  check(
    "the paused campaign is absent from a metrics query",
    !named(spend.body.results).some((n: string) => n.includes("Northwind")),
    named(spend.body.results),
  );
  check(
    "…and present in an attribute query",
    named(attributes.body.results).some((n: string) => n.includes("Northwind")),
    named(attributes.body.results),
  );

  const page1 = await search(cid, "SELECT campaign.name FROM campaign", { pageSize: 2 });
  check("pageSize 2 returns two rows and a nextPageToken", page1.body?.results?.length === 2 && !!page1.body?.nextPageToken, page1.body);
  const page2 = await search(cid, "SELECT campaign.name FROM campaign", {
    pageSize: 2,
    pageToken: page1.body.nextPageToken,
  });
  check(
    "the next page does not overlap the first",
    !named(page2.body.results).some((n: string) => named(page1.body.results).includes(n)),
    { page1: named(page1.body.results), page2: named(page2.body.results) },
  );
  const lastPage = await search(cid, "SELECT campaign.name FROM campaign", { pageSize: 10 });
  check(
    "the last page omits nextPageToken entirely, rather than sending null",
    !("nextPageToken" in lastPage.body),
    Object.keys(lastPage.body),
  );

  const counted = await search(cid, "SELECT campaign.name FROM campaign", {
    pageSize: 2,
    returnTotalResultsCount: true,
  });
  check("totalResultsCount is an int64 string", counted.body?.totalResultsCount === "5", counted.body?.totalResultsCount);

  const limited = await search(cid, "SELECT campaign.name FROM campaign LIMIT 2", {
    returnTotalResultsCount: true,
  });
  check(
    "…and counts the whole match, ignoring the query's own LIMIT",
    limited.body?.results?.length === 2 && limited.body?.totalResultsCount === "5",
    { rows: limited.body?.results?.length, total: limited.body?.totalResultsCount },
  );

  const stream = await ads(`/${API_VERSION}/customers/${cid}/googleAds:searchStream`, {
    body: { query: "SELECT campaign.name FROM campaign" },
  });
  check("searchStream answers a top-level ARRAY", Array.isArray(stream.body), stream.body);
  check(
    "…whose first chunk carries results, fieldMask and requestId",
    Array.isArray(stream.body?.[0]?.results) &&
      stream.body[0].fieldMask === "campaign.name" &&
      typeof stream.body[0].requestId === "string",
    stream.body?.[0],
  );

  // --- writes --------------------------------------------------------------
  console.log("\n  writes");

  const campaignName = `customers/${cid}/campaigns/17204885331`;
  const paused = await ads(`/${API_VERSION}/customers/${cid}/campaigns:mutate`, {
    body: { operations: [{ update: { resourceName: campaignName, status: "PAUSED" }, updateMask: "status" }] },
  });
  check("campaigns:mutate echoes the resourceName", paused.body?.results?.[0]?.resourceName === campaignName, paused.body);
  const afterPause = await search(cid, "SELECT campaign.status FROM campaign WHERE campaign.id = 17204885331");
  check("a re-query shows PAUSED", afterPause.body?.results?.[0]?.campaign?.status === "PAUSED", afterPause.body);

  await ads(`/${API_VERSION}/customers/${cid}/campaigns:mutate`, {
    body: {
      operations: [
        {
          update: { resourceName: campaignName, status: "ENABLED", name: "Renamed by accident" },
          updateMask: "status",
        },
      ],
    },
  });
  const afterMask = await search(
    cid,
    "SELECT campaign.name, campaign.status FROM campaign WHERE campaign.id = 17204885331",
  );
  check(
    "a field in the body but not in the updateMask is ignored",
    afterMask.body?.results?.[0]?.campaign?.name?.includes("Payments") &&
      afterMask.body.results[0].campaign.status === "ENABLED",
    afterMask.body?.results?.[0],
  );

  const budgetName = `customers/${cid}/campaignBudgets/11938204472`;
  await ads(`/${API_VERSION}/customers/${cid}/campaignBudgets:mutate`, {
    body: {
      operations: [
        { update: { resourceName: budgetName, amountMicros: 400000000 }, updateMask: "amountMicros" },
      ],
    },
  });
  const afterBudget = await search(
    cid,
    "SELECT campaign_budget.amount_micros FROM campaign_budget WHERE campaign_budget.id = 11938204472",
  );
  check(
    "a raised budget is visible in the next report",
    afterBudget.body?.results?.[0]?.campaignBudget?.amountMicros === "400000000",
    afterBudget.body,
  );

  const created = await ads(`/${API_VERSION}/customers/${cid}/campaignBudgets:mutate`, {
    body: { operations: [{ create: { name: "Smoke test budget", amountMicros: 12000000 } }] },
  });
  check(
    "a created budget gets a decimal id an agent cannot tell from a seeded one",
    /^customers\/\d+\/campaignBudgets\/\d{10,12}$/.test(created.body?.results?.[0]?.resourceName ?? ""),
    created.body,
  );

  const dryRun = await ads(`/${API_VERSION}/customers/${cid}/campaigns:mutate`, {
    body: {
      operations: [{ update: { resourceName: campaignName, status: "PAUSED" }, updateMask: "status" }],
      validateOnly: true,
    },
  });
  const afterDryRun = await search(cid, "SELECT campaign.status FROM campaign WHERE campaign.id = 17204885331");
  check(
    "validateOnly validates, returns no results and changes nothing",
    (dryRun.body?.results ?? []).length === 0 &&
      afterDryRun.body.results[0].campaign.status === "ENABLED",
    { dryRun: dryRun.body, after: afterDryRun.body.results[0] },
  );

  // Scoped to the session the reset opened: audit.db is a separate file that
  // deliberately SURVIVES a reset, so the unscoped trail carries every earlier
  // run of this script too.
  const sessions = await (await fetch(`${ROOT_URL}/api/activity?limit=1`)).json();
  const sessionId = sessions.sessions?.[0]?.id;
  const activity = await (
    await fetch(`${ROOT_URL}/api/activity?sessionId=${sessionId}`)
  ).json();
  const summaries: string[] = (activity.actions ?? []).map((a: any) => a.summary);
  check("the audit trail records the pause in words a person can read", summaries.some((s) => s.startsWith("Paused “")), summaries.slice(0, 5));
  check("…and the budget change with both amounts", summaries.some((s) => s.includes("$250.00 to $400.00")), summaries.slice(0, 5));
  check(
    "reads are not audit-logged — this session's four writes are the whole trail",
    summaries.length === 4,
    summaries,
  );

  // --- refusals ------------------------------------------------------------
  console.log("\n  refusals");

  await expectError(
    "an unknown field is queryError UNRECOGNIZED_FIELD",
    search(cid, "SELECT campaign.spend FROM campaign"),
    400,
    "queryError",
    "UNRECOGNIZED_FIELD",
  );
  await expectError(
    "OR in the WHERE clause is queryError BAD_SYMBOL",
    search(cid, "SELECT campaign.id FROM campaign WHERE campaign.status = 'ENABLED' OR campaign.status = 'PAUSED'"),
    400,
    "queryError",
    "BAD_SYMBOL",
  );
  await expectError(
    "REGEXP_MATCH is queryError BAD_OPERATOR",
    search(cid, "SELECT campaign.id FROM campaign WHERE campaign.name REGEXP_MATCH '.*'"),
    400,
    "queryError",
    "BAD_OPERATOR",
  );
  await expectError(
    "an unsupported FROM resource is BAD_RESOURCE_TYPE_IN_FROM_CLAUSE",
    search(cid, "SELECT campaign.id FROM keyword_view"),
    400,
    "queryError",
    "BAD_RESOURCE_TYPE_IN_FROM_CLAUSE",
  );

  const streamError = await ads(`/${API_VERSION}/customers/${cid}/googleAds:searchStream`, {
    body: { query: "SELECT campaign.spend FROM campaign" },
  });
  check(
    "a searchStream failure is array-wrapped like its success",
    Array.isArray(streamError.body) && errorCodeOf(streamError.body)?.queryError === "UNRECOGNIZED_FIELD",
    streamError.body,
  );

  await expectError(
    "a campaign create is a 501 mutateError MUTATE_NOT_ALLOWED",
    ads(`/${API_VERSION}/customers/${cid}/campaigns:mutate`, {
      body: { operations: [{ create: { name: "Nope" } }] },
    }),
    501,
    "mutateError",
    "MUTATE_NOT_ALLOWED",
  );
  await expectError(
    "an unknown campaign is mutateError RESOURCE_NOT_FOUND",
    ads(`/${API_VERSION}/customers/${cid}/campaigns:mutate`, {
      body: {
        operations: [
          { update: { resourceName: `customers/${cid}/campaigns/99999999999`, status: "PAUSED" }, updateMask: "status" },
        ],
      },
    }),
    400,
    "mutateError",
    "RESOURCE_NOT_FOUND",
  );
  await expectError(
    "removing an attached budget is campaignBudgetError CAMPAIGN_BUDGET_IN_USE",
    ads(`/${API_VERSION}/customers/${cid}/campaignBudgets:mutate`, {
      body: { operations: [{ remove: `customers/${cid}/campaignBudgets/11938204472` }] },
    }),
    400,
    "campaignBudgetError",
    "CAMPAIGN_BUDGET_IN_USE",
  );

  await expectError(
    "a dashed customer id is 401 CLIENT_CUSTOMER_ID_INVALID",
    search("480-293-8157", "SELECT campaign.id FROM campaign"),
    401,
    "authenticationError",
    "CLIENT_CUSTOMER_ID_INVALID",
  );
  await expectError(
    "an unknown customer id is 401 CUSTOMER_NOT_FOUND, not a 404",
    search("1111111111", "SELECT campaign.id FROM campaign"),
    401,
    "authenticationError",
    "CUSTOMER_NOT_FOUND",
  );
  await expectError(
    // A 400 and not a 401: DEVELOPER_TOKEN_PARAMETER_MISSING lives in
    // RequestError, because an absent header is a malformed request rather than a
    // failed identity. The bad bearer below is the 401.
    "a missing developer-token is 400 requestError DEVELOPER_TOKEN_PARAMETER_MISSING",
    ads(`/${API_VERSION}/customers/${cid}/googleAds:search`, {
      body: { query: "SELECT campaign.id FROM campaign" },
      headers: { "developer-token": "" },
    }),
    400,
    "requestError",
    "DEVELOPER_TOKEN_PARAMETER_MISSING",
  );
  await expectError(
    "a bad bearer is 401 OAUTH_TOKEN_INVALID",
    ads(`/${API_VERSION}/customers/${cid}/googleAds:search`, {
      body: { query: "SELECT campaign.id FROM campaign" },
      headers: { authorization: "Bearer wrong" },
    }),
    401,
    "authenticationError",
    "OAUTH_TOKEN_INVALID",
  );

  const unknownMethod = await ads(`/${API_VERSION}/customers/${cid}/adGroups:mutate`, { body: {} });
  check(
    "an unimplemented method is the gateway's bare 404, with no GoogleAdsFailure",
    unknownMethod.status === 404 &&
      unknownMethod.body?.error?.message === "Method not found." &&
      unknownMethod.body?.error?.details === undefined,
    unknownMethod.body,
  );

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\x1b[31msmoke crashed:\x1b[0m", err);
  process.exit(1);
});
