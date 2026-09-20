import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { listActions } from "@/lib/audit";
import { executeGaql } from "@/lib/googleads/gaql/execute";
import { parseGaql } from "@/lib/googleads/gaql/parse";
import { BadRequestError } from "@/lib/sandbox/auth";
import { injectBeat } from "@/lib/sandbox/inject";
import { parseSeedRequest } from "@/lib/sandbox/parse";
import { buildSnapshot } from "@/lib/sandbox/snapshot";
import { getBudget } from "@/lib/store/budgets";
import { getCampaign } from "@/lib/store/campaigns";
import { getCustomer } from "@/lib/store/customers";
import { getWorldNowMs } from "@/lib/store/meta";
import { countStatRows } from "@/lib/store/stats";
import {
  AG_OVER_A,
  BUDGET_OVER,
  CAMPAIGN_OVER,
  CAMPAIGN_PAUSED,
  CUSTOMER_ID,
  day,
  makeTestDb,
  WORLD_NOW_MS,
} from "./helpers";

// The control plane. The seed parser and the injector are where a scenario is
// most likely to go wrong quietly — a half-understood seed produces an account
// the agent reasons about confidently and wrongly — so both are checked for the
// message they give back, not just for the fact that they refused.

let db: Database;

beforeEach(() => {
  db = makeTestDb();
});

function wireSeed(over: Record<string, unknown> = {}): unknown {
  return {
    twin: "google-ads",
    seed: {
      world: {
        business: { name: "Acme Inc." },
        cast: [{ id: "p1", name: "Sandbox User", email: "sandbox.user@gmail.com" }],
        mailboxOwner: "sandbox.user@gmail.com",
      },
      nowISO: "2026-08-03T13:00:00.000Z",
      ownerEmail: "sandbox.user@gmail.com",
      customer: {
        id: "4802938157",
        descriptiveName: "Acme Inc.",
        currencyCode: "USD",
        timezone: "America/New_York",
      },
      budgets: [{ id: "11938204471", name: "Payments daily budget", amountMicros: 250_000_000 }],
      campaigns: [
        {
          id: "17204885331",
          budgetId: "11938204471",
          name: "Acme — Payments Integration (Search)",
          status: "ENABLED",
          advertisingChannelType: "SEARCH",
          startDate: "2026-03-16",
        },
      ],
      adGroups: [
        { id: "14802930011", campaignId: "17204885331", name: "Payments — Core", status: "ENABLED" },
      ],
      dailyStats: [
        {
          adGroupId: "14802930011",
          date: "2026-08-02",
          impressions: 1000,
          clicks: 50,
          costMicros: 200_000_000,
        },
      ],
      ...over,
    },
  };
}

function rejection(body: unknown): string {
  try {
    parseSeedRequest(body);
  } catch (err) {
    if (err instanceof BadRequestError) return err.message;
    throw err;
  }
  throw new Error("expected the seed to be rejected");
}

describe("seed parsing", () => {
  it("accepts a well-formed wire seed and normalises it", () => {
    const parsed = parseSeedRequest(wireSeed());
    expect(parsed.nowMs).toBe(WORLD_NOW_MS);
    expect(parsed.ownerName).toBe("Sandbox User");
    expect(parsed.budgets[0].deliveryMethod).toBe("STANDARD");
    expect(parsed.campaigns[0].endDate).toBeNull();
    expect(parsed.dailyStats[0].conversions).toBe(0);
  });

  it("refuses a mis-routed seed loudly rather than leaving an empty account", () => {
    expect(rejection({ ...(wireSeed() as object), twin: "calendar" })).toContain(
      "this twin seeds 'google-ads'",
    );
  });

  it("names the offending path and the fix on every failure", () => {
    expect(
      rejection(
        wireSeed({
          campaigns: [
            {
              id: "17204885331",
              budgetId: "99999999999",
              name: "Orphan",
              status: "ENABLED",
              advertisingChannelType: "SEARCH",
              startDate: "2026-03-16",
            },
          ],
        }),
      ),
    ).toBe(
      'seed.campaigns[0].budgetId "99999999999" names no budget in seed.budgets — a campaign can ' +
        "only point at a budget this seed creates",
    );
    expect(
      rejection(
        wireSeed({
          dailyStats: [
            { adGroupId: "14802930011", date: "2026-8-3", impressions: 1, clicks: 0, costMicros: 0 },
          ],
        }),
      ),
    ).toBe('seed.dailyStats[0].date "2026-8-3" must be YYYY-MM-DD');
    expect(
      rejection(
        wireSeed({
          customer: {
            id: "480-293-8157",
            descriptiveName: "Acme Inc.",
            currencyCode: "USD",
            timezone: "America/New_York",
          },
        }),
      ),
    ).toContain("must be digits only");
  });

  it("insists the account owner comes out of the cast", () => {
    expect(rejection(wireSeed({ ownerEmail: "stranger@acme.co" }))).toContain(
      "is not in seed.world.cast",
    );
  });

  it("refuses two stat rows for the same ad group and day", () => {
    const row = {
      adGroupId: "14802930011",
      date: "2026-08-02",
      impressions: 1,
      clicks: 0,
      costMicros: 0,
    };
    expect(rejection(wireSeed({ dailyStats: [row, row] }))).toContain(
      "two rows for ad group \"14802930011\" on 2026-08-02",
    );
  });

  it("refuses a status no query could ever match", () => {
    expect(
      rejection(
        wireSeed({
          campaigns: [
            {
              id: "17204885331",
              budgetId: "11938204471",
              name: "Acme",
              status: "SNOOZED",
              advertisingChannelType: "SEARCH",
              startDate: "2026-03-16",
            },
          ],
        }),
      ),
    ).toContain("must be one of ENABLED, PAUSED, REMOVED");
  });

  it("refuses an IANA zone Intl cannot build", () => {
    expect(
      rejection(
        wireSeed({
          customer: {
            id: "4802938157",
            descriptiveName: "Acme Inc.",
            currencyCode: "USD",
            timezone: "Mars/Olympus",
          },
        }),
      ),
    ).toContain("is not an IANA time zone");
  });
});

describe("inject", () => {
  const at = { atISO: "2026-08-04T13:00:00.000Z" };

  it("refuses to stamp a beat with the wall clock", () => {
    expect(() => injectBeat(db, { spend: [] })).toThrow(BadRequestError);
    expect(() =>
      injectBeat(db, {
        spend: [{ adGroupId: AG_OVER_A, impressions: 1, clicks: 0, costMicros: 0 }],
      }),
    ).toThrow("atMs or atISO is required");
  });

  it("advances the world clock, which is what makes DURING TODAY move", () => {
    const before = executeGaql(
      db,
      parseGaql("SELECT metrics.clicks FROM campaign WHERE segments.date DURING TODAY"),
      getCustomer(db, CUSTOMER_ID)!,
    );
    expect(before.rows).toEqual([]);

    injectBeat(db, {
      ...at,
      spend: [{ adGroupId: AG_OVER_A, impressions: 900, clicks: 40, costMicros: 180_000_000 }],
    });

    expect(getWorldNowMs(db)).toBe(Date.parse(at.atISO));
    // The beat's own date defaulted to the new world date, so it IS today now.
    const after = executeGaql(
      db,
      parseGaql("SELECT metrics.clicks FROM campaign WHERE segments.date DURING TODAY"),
      getCustomer(db, CUSTOMER_ID)!,
    );
    expect(after.rows[0].metrics.clicks).toBe("40");
  });

  it("replaces a day rather than doubling it when a beat is replayed", () => {
    const beat = {
      ...at,
      spend: [
        { adGroupId: AG_OVER_A, date: day(-1), impressions: 900, clicks: 40, costMicros: 180_000_000 },
      ],
    };
    const before = countStatRows(db);
    injectBeat(db, beat);
    injectBeat(db, beat);
    expect(countStatRows(db)).toBe(before);
    const row = db
      .prepare("SELECT cost_micros AS c FROM daily_stats WHERE ad_group_id = ? AND date = ?")
      .get(AG_OVER_A, day(-1)) as { c: number };
    expect(row.c).toBe(180_000_000);
  });

  it("moves a budget and a status, and hands back the resource names", () => {
    const result = injectBeat(db, {
      ...at,
      budgetChanges: [{ budgetId: BUDGET_OVER, amountMicros: 500_000_000 }],
      statusChanges: [{ campaignId: CAMPAIGN_PAUSED, status: "ENABLED" }],
    });
    expect(getBudget(db, BUDGET_OVER)?.amount_micros).toBe(500_000_000);
    expect(getCampaign(db, CAMPAIGN_PAUSED)?.status).toBe("ENABLED");
    expect(result.budgetChanges[0].resourceName).toBe(
      `customers/${CUSTOMER_ID}/campaignBudgets/${BUDGET_OVER}`,
    );
    expect(result.statusChanges[0].resourceName).toBe(
      `customers/${CUSTOMER_ID}/campaigns/${CAMPAIGN_PAUSED}`,
    );
  });

  it("leaves no trace in the audit log — the world is not the agent", () => {
    injectBeat(db, {
      ...at,
      budgetChanges: [{ budgetId: BUDGET_OVER, amountMicros: 500_000_000 }],
    });
    expect(listActions(db)).toHaveLength(0);
  });

  it("rolls the whole beat back when one part of it is unknown", () => {
    expect(() =>
      injectBeat(db, {
        ...at,
        budgetChanges: [{ budgetId: BUDGET_OVER, amountMicros: 500_000_000 }],
        statusChanges: [{ campaignId: "99999999999", status: "PAUSED" }],
      }),
    ).toThrow("unknown campaign 99999999999");
    expect(getBudget(db, BUDGET_OVER)?.amount_micros).toBe(250_000_000);
    expect(getWorldNowMs(db)).toBe(WORLD_NOW_MS);
  });
});

describe("snapshot", () => {
  it("reports the same seven-day spend the agent's own report would", () => {
    const snap = buildSnapshot(db);
    const report = executeGaql(
      db,
      parseGaql(
        "SELECT campaign.id, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS",
      ),
      getCustomer(db, CUSTOMER_ID)!,
    );
    const overspender = snap.campaigns.find((c) => c.id === CAMPAIGN_OVER)!;
    expect(String(overspender.cost7dMicros)).toBe(report.rows[0].metrics.costMicros);
    // And the budget it is being measured against comes along with it.
    expect(overspender.budgetMicros).toBe(250_000_000);
    expect(overspender.adGroups).toBe(2);
  });

  it("is a digest: campaigns and budgets, never the stat rows", () => {
    const snap = buildSnapshot(db);
    expect(snap.customer?.timeZone).toBe("America/New_York");
    expect(snap.customer?.ownerEmail).toBe("sandbox.user@gmail.com");
    expect(snap.campaigns).toHaveLength(2);
    expect(snap.budgets).toHaveLength(2);
    expect(snap.truncated).toBe(false);
    // The paused campaign is in the digest even with no spend in the window.
    expect(snap.campaigns.find((c) => c.id === CAMPAIGN_PAUSED)?.cost7dMicros).toBe(0);
  });
});
