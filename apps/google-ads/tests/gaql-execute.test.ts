import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { GoogleAdsError } from "@/lib/googleads/errors";
import { executeGaql } from "@/lib/googleads/gaql/execute";
import { parseGaql } from "@/lib/googleads/gaql/parse";
import { getCustomer } from "@/lib/store/customers";
import {
  AG_OVER_A,
  AG_OVER_B,
  BUDGET_OVER,
  BUDGET_QUIET,
  CAMPAIGN_OVER,
  CAMPAIGN_PAUSED,
  CUSTOMER_ID,
  OTHER_AD_GROUP,
  OTHER_BUDGET,
  OTHER_CAMPAIGN,
  OTHER_CUSTOMER_ID,
  day,
  makeTestDb,
  seedOtherCustomer,
} from "./helpers";

// The semantics — the suite that proves the parser is the front of a real engine
// and not a lookup table. The fixture spends $312/day on the Payments campaign
// for the fourteen days ending yesterday, against a $250 budget, and stops the
// Northwind campaign's spend ten days back.

const DOLLAR = 1_000_000;
const DAILY_COST = 312 * DOLLAR;

let db: Database;

function run(query: string) {
  return executeGaql(db, parseGaql(query), getCustomer(db, CUSTOMER_ID)!);
}

function failure(query: string): GoogleAdsError {
  try {
    run(query);
  } catch (err) {
    if (err instanceof GoogleAdsError) return err;
    throw err;
  }
  throw new Error(`expected ${JSON.stringify(query)} to fail`);
}

beforeEach(() => {
  db = makeTestDb();
});

describe("date literals", () => {
  it("resolves LAST_7_DAYS to [today-7, today-1] and excludes today", () => {
    const during = run(
      "SELECT metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS",
    );
    const explicit = run(
      `SELECT metrics.cost_micros FROM campaign WHERE segments.date BETWEEN '${day(-7)}' AND '${day(-1)}'`,
    );
    expect(during.rows).toEqual(explicit.rows);
    expect(during.rows[0].metrics.costMicros).toBe(String(7 * DAILY_COST));
  });

  it("returns nothing for TODAY, because the fixture's spend ends yesterday", () => {
    expect(run("SELECT metrics.clicks FROM campaign WHERE segments.date DURING TODAY").rows).toEqual(
      [],
    );
  });

  it("treats YESTERDAY as a single day", () => {
    const rows = run(
      "SELECT metrics.cost_micros FROM campaign WHERE segments.date DURING YESTERDAY",
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].metrics.costMicros).toBe(String(DAILY_COST));
  });

  it("covers the whole seeded range with LAST_30_DAYS", () => {
    const rows = run(
      "SELECT metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC",
    ).rows;
    expect(rows[0].metrics.costMicros).toBe(String(14 * DAILY_COST));
  });

  it("refuses an unsupported literal by name", () => {
    const err = failure(
      "SELECT metrics.clicks FROM campaign WHERE segments.date DURING LAST_BUSINESS_WEEK",
    );
    expect(err.errorCode).toEqual({ queryError: "BAD_ENUM_CONSTANT" });
    expect(err.message).toContain("LAST_7_DAYS");
  });
});

describe("aggregation", () => {
  it("gives one row per campaign when no segment is selected", () => {
    const rows = run(
      "SELECT campaign.name, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS",
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].campaign.name).toBe("Acme — Payments Integration (Search)");
  });

  it("splits into one row per day when segments.date is selected, summing back to the same total", () => {
    const total = run(
      "SELECT metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS",
    ).rows[0].metrics.costMicros as string;
    const daily = run(
      "SELECT segments.date, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS",
    ).rows;
    expect(daily).toHaveLength(7);
    expect(daily.map((r) => r.segments.date)).toEqual(
      [-7, -6, -5, -4, -3, -2, -1].map((o) => day(o)),
    );
    const summed = daily.reduce((n, r) => n + Number(r.metrics.costMicros), 0);
    expect(String(summed)).toBe(total);
  });

  it("aggregates a budget's metrics from its campaigns", () => {
    const rows = run(
      "SELECT campaign_budget.name, metrics.cost_micros FROM campaign_budget WHERE segments.date DURING LAST_7_DAYS",
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].campaignBudget.name).toBe("Payments daily budget");
    expect(rows[0].metrics.costMicros).toBe(String(7 * DAILY_COST));
  });
});

describe("rows with no spend in the window", () => {
  it("drops a resource from a metrics query", () => {
    const ids = run(
      "SELECT campaign.id, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS",
    ).rows.map((r) => r.campaign.id);
    expect(ids).toEqual([CAMPAIGN_OVER]);
  });

  it("keeps it in an attribute query", () => {
    const rows = run("SELECT campaign.name, campaign.status FROM campaign").rows;
    expect(rows.map((r) => r.campaign.status).sort()).toEqual(["ENABLED", "PAUSED"]);
    expect(rows.map((r) => r.campaign.resourceName)).toContain(
      `customers/${CUSTOMER_ID}/campaigns/${CAMPAIGN_PAUSED}`,
    );
  });
});

describe("joins", () => {
  it("resolves the attached budget from a campaign", () => {
    const row = run(
      "SELECT campaign.name, campaign_budget.amount_micros FROM campaign WHERE campaign.id = 17204885331",
    ).rows[0];
    expect(row.campaignBudget.amountMicros).toBe("250000000");
    expect(row.campaignBudget.resourceName).toBe(
      `customers/${CUSTOMER_ID}/campaignBudgets/${BUDGET_OVER}`,
    );
  });

  it("resolves upward from an ad group", () => {
    const rows = run("SELECT ad_group.name, campaign.name FROM ad_group ORDER BY ad_group.id").rows;
    expect(rows[0].adGroup.name).toBe("Payments — Core");
    expect(rows[0].campaign.name).toBe("Acme — Payments Integration (Search)");
  });

  it("refuses a field the FROM resource does not reach", () => {
    const err = failure("SELECT ad_group.name FROM campaign_budget");
    expect(err.errorCode).toEqual({ queryError: "UNRECOGNIZED_FIELD" });
    expect(err.message).toBe("Field 'ad_group.name' cannot be selected from resource 'campaign_budget'.");
  });
});

describe("proto3 JSON types", () => {
  it("serialises int64 as a string and doubles as numbers", () => {
    const row = run(
      "SELECT campaign.id, campaign_budget.amount_micros, metrics.cost_micros, metrics.conversions, metrics.ctr " +
        "FROM campaign WHERE segments.date DURING LAST_7_DAYS",
    ).rows[0];
    expect(row.campaign.id).toBe(CAMPAIGN_OVER);
    expect(typeof row.campaign.id).toBe("string");
    expect(typeof row.campaignBudget.amountMicros).toBe("string");
    expect(typeof row.metrics.costMicros).toBe("string");
    expect(typeof row.metrics.conversions).toBe("number");
    expect(typeof row.metrics.ctr).toBe("number");
  });

  it("serialises a bool as a boolean", () => {
    const rows = run(
      "SELECT campaign_budget.id, campaign_budget.explicitly_shared FROM campaign_budget ORDER BY campaign_budget.id",
    ).rows;
    expect(rows.map((r) => r.campaignBudget.explicitlyShared)).toEqual([false, true]);
  });

  it("computes ctr and average_cpc at read time", () => {
    const row = run(
      "SELECT metrics.ctr, metrics.average_cpc FROM campaign WHERE segments.date DURING LAST_7_DAYS",
    ).rows[0];
    // 350 clicks over 10500 impressions, $2184 over 350 clicks.
    expect(row.metrics.ctr).toBeCloseTo(350 / 10_500, 10);
    expect(row.metrics.averageCpc).toBeCloseTo((7 * DAILY_COST) / 350, 6);
  });

  it("omits an unset field instead of sending it as null", () => {
    // The fixture's campaigns run open-endedly, so end_date is NULL. proto3 JSON
    // has no way to say "null" for a string field: Google omits it, and an agent
    // asking `'endDate' in row.campaign` must get false here too.
    const row = run(`SELECT campaign.id, campaign.end_date FROM campaign WHERE campaign.id = ${CAMPAIGN_OVER}`)
      .rows[0];
    expect(row.campaign.id).toBe(CAMPAIGN_OVER);
    expect("endDate" in row.campaign).toBe(false);
  });

  it("still names a joined resource whose every selected field was unset", () => {
    // Nothing about the campaign survives the omission, but the campaign is still
    // in the row because it is still in the join — so its resourceName is the
    // whole of its container.
    const row = run(`SELECT ad_group.name, campaign.end_date FROM ad_group WHERE ad_group.id = ${AG_OVER_A}`)
      .rows[0];
    expect(row.campaign).toEqual({
      resourceName: `customers/${CUSTOMER_ID}/campaigns/${CAMPAIGN_OVER}`,
    });
  });

  it("returns 0 rather than dividing by zero", () => {
    const row = run(
      `SELECT metrics.ctr, metrics.average_cpc FROM ad_group WHERE ad_group.id = ${AG_OVER_B} AND segments.date DURING LAST_7_DAYS`,
    ).rows[0];
    expect(row.metrics.ctr).toBe(0);
    expect(row.metrics.averageCpc).toBe(0);
  });
});

describe("response shape", () => {
  it("carries resourceName on every resource in the row, selected or not", () => {
    const row = run("SELECT campaign.name, campaign_budget.name FROM campaign LIMIT 1").rows[0];
    expect(row.campaign.resourceName).toBe(`customers/${CUSTOMER_ID}/campaigns/${CAMPAIGN_OVER}`);
    expect(row.campaignBudget.resourceName).toBe(
      `customers/${CUSTOMER_ID}/campaignBudgets/${BUDGET_OVER}`,
    );
  });

  it("names the FROM resource even when nothing about it was selected", () => {
    // Spend per campaign with no attributes is the commonest report an agent
    // writes; without the campaign's own name its rows are anonymous numbers.
    const result = run("SELECT metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS");
    expect(result.rows[0].campaign.resourceName).toBe(
      `customers/${CUSTOMER_ID}/campaigns/${CAMPAIGN_OVER}`,
    );
    // …and the fieldMask still lists only the SELECT, as the real API's does.
    expect(result.fieldMask).toBe("metrics.clicks");
  });

  it("lands that name in the right container for every FROM resource", () => {
    // The container is the camelCase SINGULAR, and a metrics-only query is the
    // only thing that exercises it — every other query reaches it via the
    // selected field's own json path.
    const nameFrom = (resource: string, container: string) =>
      run(`SELECT metrics.clicks FROM ${resource}`).rows[0][container]?.resourceName;
    expect(nameFrom("customer", "customer")).toBe(`customers/${CUSTOMER_ID}`);
    expect(nameFrom("campaign", "campaign")).toBe(
      `customers/${CUSTOMER_ID}/campaigns/${CAMPAIGN_OVER}`,
    );
    expect(nameFrom("campaign_budget", "campaignBudget")).toBe(
      `customers/${CUSTOMER_ID}/campaignBudgets/${BUDGET_OVER}`,
    );
    expect(nameFrom("ad_group", "adGroup")).toBe(
      `customers/${CUSTOMER_ID}/adGroups/${AG_OVER_A}`,
    );
  });

  it("gives metrics and segments no resourceName — they are not resources", () => {
    const row = run(
      "SELECT segments.date, metrics.clicks FROM campaign WHERE segments.date DURING YESTERDAY",
    ).rows[0];
    expect(row.metrics.resourceName).toBeUndefined();
    expect(row.segments.resourceName).toBeUndefined();
  });

  it("lists the fieldMask in SELECT order, camelCased", () => {
    expect(
      run(
        "SELECT campaign.name, campaign_budget.amount_micros, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS",
      ).fieldMask,
    ).toBe("campaign.name,campaignBudget.amountMicros,metrics.costMicros");
  });
});

describe("filters", () => {
  it("matches an enum with equality and rejects a value outside the enum", () => {
    expect(run("SELECT campaign.id FROM campaign WHERE campaign.status = 'PAUSED'").rows).toHaveLength(
      1,
    );
    const err = failure("SELECT campaign.id FROM campaign WHERE campaign.status = 'SNOOZED'");
    expect(err.errorCode).toEqual({ queryError: "BAD_ENUM_CONSTANT" });
    expect(err.message).toBe("Unrecognized enum value 'SNOOZED' for field 'campaign.status'.");
  });

  it("honours LIKE with the caller's wildcards", () => {
    expect(
      run("SELECT campaign.id FROM campaign WHERE campaign.name LIKE '%Payments%'").rows,
    ).toHaveLength(1);
    expect(
      run("SELECT campaign.id FROM campaign WHERE campaign.name LIKE '%Nothing%'").rows,
    ).toHaveLength(0);
  });

  it("binds every element of an IN list", () => {
    expect(
      run("SELECT campaign.id FROM campaign WHERE campaign.status IN ('ENABLED', 'PAUSED')").rows,
    ).toHaveLength(2);
  });

  it("applies a metrics filter after aggregation, not before", () => {
    // One day is $312; the seven-day sum is $2184 — a threshold between the two
    // can only be satisfied by the aggregate.
    expect(
      run(
        "SELECT campaign.id FROM campaign WHERE segments.date DURING LAST_7_DAYS AND metrics.cost_micros > 1000000000",
      ).rows,
    ).toHaveLength(1);
    expect(
      run(
        "SELECT campaign.id FROM campaign WHERE segments.date DURING LAST_7_DAYS AND metrics.cost_micros > 9000000000",
      ).rows,
    ).toHaveLength(0);
  });

  it("rejects a non-numeric value on a numeric field", () => {
    expect(
      failure("SELECT campaign.id FROM campaign WHERE campaign_budget.amount_micros > 'lots'")
        .errorCode,
    ).toEqual({ queryError: "BAD_VALUE" });
  });

  // The round trip. Everything an agent does with this API is "read a report,
  // then act on one of its rows", and a resource name is what a row is called —
  // so the name a query hands back has to work as the next query's operand.
  // Compiled against the bare id column instead, these matched zero rows and
  // answered HTTP 200, which is indistinguishable from "no such campaign".
  it("feeds every resource name it returned back into a WHERE clause", () => {
    for (const [resource, container] of [
      ["customer", "customer"],
      ["campaign", "campaign"],
      ["campaign_budget", "campaignBudget"],
      ["ad_group", "adGroup"],
    ] as const) {
      const name = run(`SELECT ${resource}.resource_name FROM ${resource} LIMIT 1`).rows[0][container]
        .resourceName as string;
      const back = run(
        `SELECT ${resource}.resource_name FROM ${resource} WHERE ${resource}.resource_name = '${name}'`,
      ).rows;
      expect(back).toHaveLength(1);
      expect(back[0][container].resourceName).toBe(name);
    }
  });

  it("filters an implicit join by the parent's resource name", () => {
    // `ad_group.campaign` and `campaign.campaign_budget` are the two fields whose
    // value is somebody ELSE's name, and they are how an agent walks down from a
    // campaign it just found to the rows underneath it.
    const ids = run(
      `SELECT ad_group.id FROM ad_group WHERE ad_group.campaign = 'customers/${CUSTOMER_ID}/campaigns/${CAMPAIGN_OVER}'`,
    ).rows.map((r) => r.adGroup.id);
    expect(ids).toEqual([AG_OVER_A, AG_OVER_B]);

    const campaigns = run(
      `SELECT campaign.id FROM campaign WHERE campaign.campaign_budget = 'customers/${CUSTOMER_ID}/campaignBudgets/${BUDGET_QUIET}'`,
    ).rows.map((r) => r.campaign.id);
    expect(campaigns).toEqual([CAMPAIGN_PAUSED]);
  });

  it("gives a name built in SQL and one built in TypeScript the same text", () => {
    // Two renderers spell this path — `resourceNameSql` for a selected field and
    // `resourceNameFor` for the name every resource carries anyway — and the
    // round trip above only holds while they agree.
    const row = run(
      `SELECT ad_group.campaign, campaign.name FROM ad_group WHERE ad_group.id = ${AG_OVER_A}`,
    ).rows[0];
    expect(row.adGroup.campaign).toBe(row.campaign.resourceName);
  });

  it("matches nothing for a name that belongs to another advertiser", () => {
    // Not an error: a path is a legal operand and this one is simply not in this
    // account. Binding the id out of it would have matched a row here whose
    // number happened to collide.
    seedOtherCustomer(db);
    expect(
      run(
        `SELECT campaign.id FROM campaign WHERE campaign.resource_name = 'customers/${OTHER_CUSTOMER_ID}/campaigns/${OTHER_CAMPAIGN}'`,
      ).rows,
    ).toHaveLength(0);
  });
});

describe("ordering and paging", () => {
  it("puts the overspender first when ordering by cost descending", () => {
    const rows = run(
      "SELECT campaign.id, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC",
    ).rows;
    expect(rows.map((r) => r.campaign.id)).toEqual([CAMPAIGN_OVER, CAMPAIGN_PAUSED]);
  });

  it("applies LIMIT after ordering", () => {
    const rows = run(
      "SELECT campaign.id, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros ASC LIMIT 1",
    ).rows;
    expect(rows.map((r) => r.campaign.id)).toEqual([CAMPAIGN_PAUSED]);
  });

  it("counts what the query matched before the LIMIT clipped it", () => {
    // totalResultsCount is defined as the match count ignoring LIMIT, so the two
    // numbers here have to disagree.
    const limited = run("SELECT campaign.id FROM campaign LIMIT 1");
    expect(limited.rows).toHaveLength(1);
    expect(limited.totalCount).toBe(2);
  });

  it("returns every row and leaves paging to the route", () => {
    // Fourteen segmented rows come back whole; the search route is what slices
    // them, which is how searchStream can share this executor unchanged.
    expect(
      run(
        "SELECT segments.date, metrics.clicks FROM campaign WHERE segments.date DURING LAST_14_DAYS AND campaign.id = 17204885331",
      ).rows,
    ).toHaveLength(14);
  });
});

// The account boundary. A Google Ads customer is a tenant: the id in the request
// path is the whole of an advertiser's isolation, and a query that ignores it
// returns a superset that still parses, still has the right shape, and is wrong
// in the one way nobody checks for. The fixture seeds a second advertiser whose
// numbers are deliberately unmistakable — 9999 impressions, $999/day — so a
// missing scope shows up as a value no assertion here would ever expect.
describe("customer scoping", () => {
  beforeEach(() => seedOtherCustomer(db));

  it("keeps another advertiser's campaigns out of an attribute query", () => {
    const res = run("SELECT campaign.id, campaign.name FROM campaign");
    const ids = res.rows.map((r) => r.campaign.id);
    expect(ids).toContain(CAMPAIGN_OVER);
    expect(ids).not.toContain(OTHER_CAMPAIGN);
  });

  it("keeps another advertiser's spend out of a metrics query", () => {
    const res = run("SELECT campaign.id, metrics.cost_micros FROM campaign");
    const ids = res.rows.map((r) => r.campaign.id);
    expect(ids).not.toContain(OTHER_CAMPAIGN);
    // $312/day for fourteen days on the Payments campaign plus $28/day for the
    // five days the Northwind one ran. The other advertiser's $999/day appears
    // nowhere — an unscoped SUM would be nearly four times this.
    const total = res.rows.reduce((sum, row) => sum + Number(row.metrics!.costMicros), 0);
    expect(total).toBe(14 * DAILY_COST + 5 * 28 * DOLLAR);
  });

  it("scopes ad groups and budgets too, not just campaigns", () => {
    const ags = run("SELECT ad_group.id FROM ad_group").rows.map((r) => r.adGroup.id);
    expect(ags).toContain(AG_OVER_A);
    expect(ags).not.toContain(OTHER_AD_GROUP);

    const budgets = run("SELECT campaign_budget.id FROM campaign_budget").rows.map(
      (r) => r.campaignBudget.id,
    );
    expect(budgets).toContain(BUDGET_OVER);
    expect(budgets).not.toContain(OTHER_BUDGET);
  });

  it("returns only the requesting customer from a customer query", () => {
    const res = run("SELECT customer.id, customer.descriptive_name FROM customer");
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].customer.id).toBe(CUSTOMER_ID);
  });

  it("totalResultsCount counts the scoped rows, not every advertiser's", () => {
    const res = run("SELECT campaign.id FROM campaign");
    expect(res.totalCount).toBe(2);
  });
});
