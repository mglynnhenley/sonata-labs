import type { Database } from "better-sqlite3";
import { getAdGroup } from "./adGroups";

// The fact table, at (ad_group, date) grain.
//
// These are the FIXED-shape helpers — seeding, injecting and counting. The
// report SQL is dynamic, because the shape of a report is decided by the query
// and cannot be a prepared statement, so it is built in gaql/execute.ts instead;
// that file is the one deliberate exception to "all SQL lives in store/", and it
// says so in its own header.

export interface DailyStatRow {
  customer_id: string;
  campaign_id: string;
  ad_group_id: string;
  date: string;
  impressions: number;
  clicks: number;
  cost_micros: number;
  conversions: number;
  conversions_value: number;
}

export interface InsertDailyStatInput {
  customerId: string;
  campaignId: string;
  adGroupId: string;
  date: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions?: number;
  conversionsValue?: number;
}

/** Upsert on (ad_group_id, date): replaying a beat replaces the day, never doubles it. */
export function insertDailyStat(db: Database, input: InsertDailyStatInput): void {
  db.prepare(
    `INSERT INTO daily_stats
       (customer_id, campaign_id, ad_group_id, date, impressions, clicks, cost_micros, conversions, conversions_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ad_group_id, date) DO UPDATE SET
       customer_id = excluded.customer_id,
       campaign_id = excluded.campaign_id,
       impressions = excluded.impressions,
       clicks = excluded.clicks,
       cost_micros = excluded.cost_micros,
       conversions = excluded.conversions,
       conversions_value = excluded.conversions_value`,
  ).run(
    input.customerId,
    input.campaignId,
    input.adGroupId,
    input.date,
    input.impressions,
    input.clicks,
    input.costMicros,
    input.conversions ?? 0,
    input.conversionsValue ?? 0,
  );
}

export interface SpendInput {
  adGroupId: string;
  date: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions?: number;
  conversionsValue?: number;
}

/**
 * Record a day of spend for an ad group, resolving the customer and campaign from
 * the ad group itself. An unknown ad group throws rather than inventing a row:
 * orphaned spend would show up in an account total that no campaign explains.
 */
export function upsertSpend(db: Database, input: SpendInput): void {
  const adGroup = getAdGroup(db, input.adGroupId);
  if (!adGroup) throw new Error(`unknown ad group ${input.adGroupId}`);
  insertDailyStat(db, {
    customerId: adGroup.customer_id,
    campaignId: adGroup.campaign_id,
    adGroupId: adGroup.id,
    date: input.date,
    impressions: input.impressions,
    clicks: input.clicks,
    costMicros: input.costMicros,
    conversions: input.conversions,
    conversionsValue: input.conversionsValue,
  });
}

export function countStatRows(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM daily_stats").get() as { n: number }).n;
}

/** Ascending, for the seed CLI's "N stat rows across M days" line. */
export function distinctDates(db: Database): string[] {
  return (
    db.prepare("SELECT DISTINCT date FROM daily_stats ORDER BY date").all() as Array<{
      date: string;
    }>
  ).map((r) => r.date);
}
