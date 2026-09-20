import type { Database } from "better-sqlite3";
import { addDays } from "./googleads/dates";
import { insertAdGroup } from "./store/adGroups";
import { insertBudget } from "./store/budgets";
import { insertCampaign } from "./store/campaigns";
import { insertCustomer } from "./store/customers";
import { setMeta } from "./store/meta";
import { insertDailyStat } from "./store/stats";

// The synthetic demo account, so the clone runs with no orchestrator and no real
// Google Ads credentials.
//
// It deliberately shares its business and its people with the Gmail and Calendar
// twins — Acme, acme.co, sandbox.user@gmail.com — because an account seeded with
// its own invented company would be a fourth fixture rather than a fourth
// surface of one company, and the whole premise is that the Priya in the inbox
// is the Priya on the invite.
//
// Nothing here is random. Every number comes from a fixed per-ad-group profile
// times a fixed weekday multiplier, because two seeds of the same world that
// disagreed about last week's spend would make every report irreproducible.

export const SEED_CUSTOMER_ID = "4802938157";
export const SEED_OWNER_EMAIL = "sandbox.user@gmail.com";
export const SEED_OWNER_NAME = "Sandbox User";
export const SEED_TIME_ZONE = "America/New_York";

/**
 * Monday 2026-08-03 09:00 ET. Anchored to a fixed instant so seeds are
 * reproducible run to run, and chosen so DURING LAST_7_DAYS resolves to
 * 2026-07-27 … 2026-08-02 — the exact week the Calendar twin seeds.
 */
export const SEED_WORLD_NOW_MS = Date.UTC(2026, 7, 3, 13, 0, 0);

export const STATS_FIRST_DATE = "2026-07-04";
export const STATS_LAST_DATE = "2026-08-02";

/** The day the Payments campaign's spend steps up — the overspend has a start. */
export const OVERSPEND_FROM = "2026-07-28";

/** The day Northwind ABM was paused; its stats stop with it. */
export const NORTHWIND_PAUSED_ON = "2026-07-20";

export const BUDGET_BRAND = "11938204471";
export const BUDGET_PAYMENTS = "11938204472";
export const BUDGET_RETARGETING = "11938204473";
export const BUDGET_NORTHWIND = "11938204474";
export const BUDGET_CAREERS = "11938204475";

export const CAMPAIGN_BRAND = "17204885330";
export const CAMPAIGN_PAYMENTS = "17204885331";
export const CAMPAIGN_RETARGETING = "17204885332";
export const CAMPAIGN_NORTHWIND = "17204885333";
export const CAMPAIGN_CAREERS = "17204885334";

/**
 * Traffic is weekly, not flat: business search collapses at the weekend. Indexed
 * by JS day-of-week (0 = Sunday), and the same curve applies to every metric so
 * ctr stays plausible across the week.
 */
const WEEKDAY_MULTIPLIER = [0.6, 1.05, 1.1, 1.08, 1.0, 0.95, 0.55];

interface AdGroupProfile {
  id: string;
  campaignId: string;
  name: string;
  cpcBidMicros: number;
  impressions: number;
  clicks: number;
  /** Daily cost in micros before OVERSPEND_FROM. */
  costMicros: number;
  /** Daily cost in micros from OVERSPEND_FROM onwards; absent means no step. */
  stepCostMicros?: number;
  conversions: number;
  /** Revenue per conversion, in whole currency units. */
  valuePerConversion: number;
  /** Absent means it ran the whole window. */
  lastDate?: string;
}

const DOLLAR = 1_000_000;

const AD_GROUPS: AdGroupProfile[] = [
  {
    id: "14802930011",
    campaignId: CAMPAIGN_BRAND,
    name: "Brand — Exact",
    cpcBidMicros: 1.2 * DOLLAR,
    impressions: 4200,
    clicks: 310,
    costMicros: 40 * DOLLAR,
    conversions: 9,
    valuePerConversion: 180,
  },
  {
    id: "14802930012",
    campaignId: CAMPAIGN_BRAND,
    name: "Brand — Phrase",
    cpcBidMicros: 1.1 * DOLLAR,
    impressions: 2600,
    clicks: 170,
    costMicros: 22 * DOLLAR,
    conversions: 4,
    valuePerConversion: 180,
  },
  {
    id: "14802930021",
    campaignId: CAMPAIGN_PAYMENTS,
    name: "Payments — Core",
    cpcBidMicros: 6.5 * DOLLAR,
    impressions: 9100,
    clicks: 320,
    costMicros: 100 * DOLLAR,
    stepCostMicros: 230 * DOLLAR,
    conversions: 6,
    valuePerConversion: 950,
  },
  {
    id: "14802930022",
    campaignId: CAMPAIGN_PAYMENTS,
    name: "Payments — Competitor",
    cpcBidMicros: 9 * DOLLAR,
    impressions: 5400,
    clicks: 140,
    costMicros: 50 * DOLLAR,
    stepCostMicros: 110 * DOLLAR,
    conversions: 2,
    valuePerConversion: 950,
  },
  {
    id: "14802930023",
    campaignId: CAMPAIGN_PAYMENTS,
    name: "Payments — Integrations",
    cpcBidMicros: 5 * DOLLAR,
    impressions: 3300,
    clicks: 95,
    costMicros: 30 * DOLLAR,
    stepCostMicros: 72 * DOLLAR,
    conversions: 1,
    valuePerConversion: 950,
  },
  {
    id: "14802930031",
    campaignId: CAMPAIGN_RETARGETING,
    name: "Retargeting — 30 day",
    cpcBidMicros: 0.4 * DOLLAR,
    impressions: 48000,
    clicks: 420,
    costMicros: 31 * DOLLAR,
    conversions: 3,
    valuePerConversion: 420,
  },
  {
    id: "14802930041",
    campaignId: CAMPAIGN_NORTHWIND,
    name: "Northwind — Brand",
    cpcBidMicros: 3.5 * DOLLAR,
    impressions: 1800,
    clicks: 62,
    costMicros: 28 * DOLLAR,
    conversions: 1,
    valuePerConversion: 1400,
    lastDate: NORTHWIND_PAUSED_ON,
  },
  {
    id: "14802930042",
    campaignId: CAMPAIGN_NORTHWIND,
    name: "Northwind — Solutions",
    cpcBidMicros: 3.2 * DOLLAR,
    impressions: 1200,
    clicks: 41,
    costMicros: 20 * DOLLAR,
    conversions: 0.5,
    valuePerConversion: 1400,
    lastDate: NORTHWIND_PAUSED_ON,
  },
  {
    id: "14802930051",
    campaignId: CAMPAIGN_CAREERS,
    name: "Careers — Engineering",
    cpcBidMicros: 0.9 * DOLLAR,
    impressions: 3100,
    clicks: 88,
    costMicros: 11 * DOLLAR,
    conversions: 0.5,
    valuePerConversion: 0,
  },
];

function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function everyDate(first: string, last: string): string[] {
  const dates: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) dates.push(d);
  return dates;
}

export function seedDatabase(db: Database): void {
  setMeta(db, "owner_email", SEED_OWNER_EMAIL);
  setMeta(db, "owner_name", SEED_OWNER_NAME);
  setMeta(db, "customer_id", SEED_CUSTOMER_ID);
  setMeta(db, "world_now_ms", String(SEED_WORLD_NOW_MS));
  setMeta(db, "seeded_at", String(SEED_WORLD_NOW_MS));

  insertCustomer(db, {
    id: SEED_CUSTOMER_ID,
    descriptiveName: "Acme Inc.",
    currencyCode: "USD",
    timeZone: SEED_TIME_ZONE,
  });

  const budgets: Array<[string, string, number]> = [
    [BUDGET_BRAND, "Brand daily budget", 80 * DOLLAR],
    [BUDGET_PAYMENTS, "Payments daily budget", 250 * DOLLAR],
    [BUDGET_RETARGETING, "Retargeting daily budget", 40 * DOLLAR],
    [BUDGET_NORTHWIND, "Northwind ABM daily budget", 60 * DOLLAR],
    [BUDGET_CAREERS, "Careers daily budget", 15 * DOLLAR],
  ];
  for (const [id, name, amountMicros] of budgets) {
    insertBudget(db, { id, customerId: SEED_CUSTOMER_ID, name, amountMicros });
  }

  const campaigns: Array<{
    id: string;
    budgetId: string;
    name: string;
    status: string;
    channel: string;
    startDate: string;
  }> = [
    { id: CAMPAIGN_BRAND, budgetId: BUDGET_BRAND, name: "Acme — Brand (Search)", status: "ENABLED", channel: "SEARCH", startDate: "2025-11-03" },
    { id: CAMPAIGN_PAYMENTS, budgetId: BUDGET_PAYMENTS, name: "Acme — Payments Integration (Search)", status: "ENABLED", channel: "SEARCH", startDate: "2026-03-16" },
    { id: CAMPAIGN_RETARGETING, budgetId: BUDGET_RETARGETING, name: "Acme — Retargeting (Display)", status: "ENABLED", channel: "DISPLAY", startDate: "2026-01-12" },
    // Paused mid-window on purpose: it is present in an attribute query and
    // absent from a metrics one, which is real Google behaviour and the single
    // most surprising thing a reporting agent meets.
    { id: CAMPAIGN_NORTHWIND, budgetId: BUDGET_NORTHWIND, name: "Acme — Northwind ABM (Search)", status: "PAUSED", channel: "SEARCH", startDate: "2026-05-04" },
    { id: CAMPAIGN_CAREERS, budgetId: BUDGET_CAREERS, name: "Acme — Careers (Search)", status: "ENABLED", channel: "SEARCH", startDate: "2026-06-01" },
  ];
  for (const c of campaigns) {
    insertCampaign(db, {
      id: c.id,
      customerId: SEED_CUSTOMER_ID,
      budgetId: c.budgetId,
      name: c.name,
      status: c.status,
      advertisingChannelType: c.channel,
      startDate: c.startDate,
    });
  }

  for (const profile of AD_GROUPS) {
    insertAdGroup(db, {
      id: profile.id,
      customerId: SEED_CUSTOMER_ID,
      campaignId: profile.campaignId,
      name: profile.name,
      cpcBidMicros: profile.cpcBidMicros,
    });
  }

  const dates = everyDate(STATS_FIRST_DATE, STATS_LAST_DATE);
  for (const profile of AD_GROUPS) {
    for (const date of dates) {
      if (profile.lastDate && date > profile.lastDate) continue;
      const m = WEEKDAY_MULTIPLIER[weekdayOf(date)];
      const base =
        profile.stepCostMicros !== undefined && date >= OVERSPEND_FROM
          ? profile.stepCostMicros
          : profile.costMicros;
      const conversions = Math.round(profile.conversions * m * 10) / 10;
      insertDailyStat(db, {
        customerId: SEED_CUSTOMER_ID,
        campaignId: profile.campaignId,
        adGroupId: profile.id,
        date,
        impressions: Math.round(profile.impressions * m),
        clicks: Math.round(profile.clicks * m),
        costMicros: Math.round(base * m),
        conversions,
        conversionsValue: Math.round(conversions * profile.valuePerConversion * 100) / 100,
      });
    }
  }
}
