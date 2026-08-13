import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AUDIT_DDL } from "@/lib/db";
import { addDays, formatInZone } from "@/lib/googleads/dates";
import { insertAdGroup } from "@/lib/store/adGroups";
import { insertBudget } from "@/lib/store/budgets";
import { insertCampaign } from "@/lib/store/campaigns";
import { insertCustomer } from "@/lib/store/customers";
import { setMeta } from "@/lib/store/meta";
import { insertDailyStat } from "@/lib/store/stats";

// The whole test harness. The REAL schema is read off disk, so a regression in
// db/schema.sql fails the suite rather than silently diverging from production.
const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");

export const CUSTOMER_ID = "4802938157";
/** A second advertiser, so "scoped to one account" is a testable claim and not
 *  an assumption that holds only while the fixture has a single tenant. */
export const OTHER_CUSTOMER_ID = "9911002233";
export const OTHER_BUDGET = "11938209991";
export const OTHER_CAMPAIGN = "17204889991";
export const OTHER_AD_GROUP = "14802939991";
export const TZ = "America/New_York";

/** The same Monday 2026-08-03 09:00 ET the demo seed uses, so the two cannot drift. */
export const WORLD_NOW_MS = Date.UTC(2026, 7, 3, 13, 0, 0);

/** The world's date, `offset` days away. `day(-1)` is the last day of LAST_7_DAYS. */
export function day(offset: number): string {
  return addDays(formatInZone(WORLD_NOW_MS, TZ), offset);
}

export const BUDGET_OVER = "11938204471";
export const BUDGET_QUIET = "11938204472";
export const CAMPAIGN_OVER = "17204885331";
export const CAMPAIGN_PAUSED = "17204885333";
export const AG_OVER_A = "14802930011";
export const AG_OVER_B = "14802930012";
export const AG_PAUSED_A = "14802930041";
export const AG_PAUSED_B = "14802930042";

const DOLLAR = 1_000_000;

/**
 * Two campaigns that between them cover every case the executor has to get
 * right: one ENABLED campaign spending over its $250 budget every day of the
 * window, and one PAUSED campaign whose stats stop ten days back — present in an
 * attribute query, absent from a metrics one.
 */
export function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(schema);
  // Mirror production's ATTACHed audit.db so mutation code paths that log can
  // run unchanged under test.
  db.prepare("ATTACH DATABASE ':memory:' AS audit").run();
  db.exec(AUDIT_DDL);

  setMeta(db, "owner_email", "sandbox.user@gmail.com");
  setMeta(db, "customer_id", CUSTOMER_ID);
  setMeta(db, "world_now_ms", String(WORLD_NOW_MS));

  insertCustomer(db, {
    id: CUSTOMER_ID,
    descriptiveName: "Acme Inc.",
    currencyCode: "USD",
    timeZone: TZ,
  });

  insertBudget(db, {
    id: BUDGET_OVER,
    customerId: CUSTOMER_ID,
    name: "Payments daily budget",
    amountMicros: 250 * DOLLAR,
  });
  insertBudget(db, {
    id: BUDGET_QUIET,
    customerId: CUSTOMER_ID,
    name: "Northwind ABM daily budget",
    amountMicros: 60 * DOLLAR,
    explicitlyShared: true,
  });

  insertCampaign(db, {
    id: CAMPAIGN_OVER,
    customerId: CUSTOMER_ID,
    budgetId: BUDGET_OVER,
    name: "Acme — Payments Integration (Search)",
    startDate: "2026-03-16",
  });
  insertCampaign(db, {
    id: CAMPAIGN_PAUSED,
    customerId: CUSTOMER_ID,
    budgetId: BUDGET_QUIET,
    name: "Acme — Northwind ABM (Search)",
    status: "PAUSED",
    startDate: "2026-05-04",
  });

  const adGroups: Array<[string, string, string]> = [
    [AG_OVER_A, CAMPAIGN_OVER, "Payments — Core"],
    [AG_OVER_B, CAMPAIGN_OVER, "Payments — Competitor"],
    [AG_PAUSED_A, CAMPAIGN_PAUSED, "Northwind — Brand"],
    [AG_PAUSED_B, CAMPAIGN_PAUSED, "Northwind — Solutions"],
  ];
  for (const [id, campaignId, name] of adGroups) {
    insertAdGroup(db, {
      id,
      customerId: CUSTOMER_ID,
      campaignId,
      name,
      cpcBidMicros: 5 * DOLLAR,
    });
  }

  // Fourteen days ending yesterday, so LAST_7_DAYS and LAST_14_DAYS are both
  // fully covered and TODAY is deliberately empty.
  for (let offset = -14; offset <= -1; offset++) {
    const date = day(offset);
    insertDailyStat(db, {
      customerId: CUSTOMER_ID,
      campaignId: CAMPAIGN_OVER,
      adGroupId: AG_OVER_A,
      date,
      impressions: 1000,
      clicks: 50,
      costMicros: 200 * DOLLAR,
      conversions: 2,
      conversionsValue: 1900,
    });
    insertDailyStat(db, {
      customerId: CUSTOMER_ID,
      campaignId: CAMPAIGN_OVER,
      adGroupId: AG_OVER_B,
      date,
      impressions: 500,
      clicks: 0,
      costMicros: 112 * DOLLAR,
      conversions: 0,
      conversionsValue: 0,
    });
    // Stops ten days back, the day the campaign was paused.
    if (offset <= -10) {
      insertDailyStat(db, {
        customerId: CUSTOMER_ID,
        campaignId: CAMPAIGN_PAUSED,
        adGroupId: AG_PAUSED_A,
        date,
        impressions: 300,
        clicks: 12,
        costMicros: 28 * DOLLAR,
        conversions: 1,
        conversionsValue: 1400,
      });
    }
  }

  return db;
}

/**
 * A second advertiser with its own budget, campaign, ad group and spend on the
 * same dates, added ON REQUEST rather than by default. A query scoped to
 * CUSTOMER_ID that quietly forgot to scope itself returns this advertiser's rows
 * too, which is the only way to catch it; but the base fixture stays a
 * single-tenant world so the counts every other suite asserts still mean what
 * they say.
 */
export function seedOtherCustomer(db: Database.Database): void {
  insertCustomer(db, {
    id: OTHER_CUSTOMER_ID,
    descriptiveName: "Vertex Logistics",
    currencyCode: "USD",
    timeZone: TZ,
  });
  insertBudget(db, {
    id: OTHER_BUDGET,
    customerId: OTHER_CUSTOMER_ID,
    name: "Vertex daily budget",
    amountMicros: 500 * DOLLAR,
  });
  insertCampaign(db, {
    id: OTHER_CAMPAIGN,
    customerId: OTHER_CUSTOMER_ID,
    budgetId: OTHER_BUDGET,
    name: "Vertex — Freight (Search)",
    startDate: "2026-04-01",
  });
  insertAdGroup(db, {
    id: OTHER_AD_GROUP,
    customerId: OTHER_CUSTOMER_ID,
    campaignId: OTHER_CAMPAIGN,
    name: "Freight — Core",
    cpcBidMicros: 9 * DOLLAR,
  });
  for (let offset = -14; offset <= -1; offset++) {
    insertDailyStat(db, {
      customerId: OTHER_CUSTOMER_ID,
      campaignId: OTHER_CAMPAIGN,
      adGroupId: OTHER_AD_GROUP,
      date: day(offset),
      impressions: 9999,
      clicks: 999,
      costMicros: 999 * DOLLAR,
      conversions: 99,
      conversionsValue: 99999,
    });
  }
}
