import type { Database } from "better-sqlite3";
import { addDays, formatInZone } from "../googleads/dates";
import { listBudgets } from "../store/budgets";
import { listCampaigns } from "../store/campaigns";
import { getOnlyCustomer } from "../store/customers";
import { getOwnerEmail, getWorldNowMs } from "../store/meta";

// The account as the judge sees it, diffed either side of the agent.
//
// A digest, never a dump: 261 stat rows is not a snapshot, it is a database, and
// a diff over it would be unreadable. What matters is the shape of the account —
// what each campaign is called, whether it is running, what it is allowed to
// spend and what it actually spent — so that is what this captures.
//
// `cost7dMicros` uses the same LAST_7_DAYS window the agent's own report uses,
// so the judge and the agent are looking at the same number rather than two
// defensible ones.

const MAX_CAMPAIGNS = 50;
const MAX_BUDGETS = 50;

export interface SnapshotCampaign {
  id: string;
  name: string;
  status: string;
  budgetId: string | null;
  budgetMicros: number | null;
  cost7dMicros: number;
  adGroups: number;
}

export interface TwinSnapshot {
  ok: true;
  worldNowMs: number;
  /** `ownerEmail` is the cast member the seed named — whose account this is. */
  customer: {
    id: string;
    descriptiveName: string;
    currencyCode: string;
    timeZone: string;
    ownerEmail: string;
  } | null;
  campaigns: SnapshotCampaign[];
  budgets: Array<{ id: string; name: string; amountMicros: number }>;
  truncated: boolean;
}

export function buildSnapshot(db: Database): TwinSnapshot {
  const customer = getOnlyCustomer(db);
  const worldNowMs = getWorldNowMs(db);
  if (!customer) {
    return { ok: true, worldNowMs, customer: null, campaigns: [], budgets: [], truncated: false };
  }

  const today = formatInZone(worldNowMs, customer.time_zone);
  const windowStart = addDays(today, -7);
  const windowEnd = addDays(today, -1);

  const allCampaigns = listCampaigns(db, customer.id);
  const allBudgets = listBudgets(db, customer.id);
  const budgetById = new Map(allBudgets.map((b) => [b.id, b]));

  const cost = db.prepare(
    "SELECT COALESCE(SUM(cost_micros), 0) AS n FROM daily_stats WHERE campaign_id = ? AND date BETWEEN ? AND ?",
  );
  const adGroupCount = db.prepare("SELECT COUNT(*) AS n FROM ad_groups WHERE campaign_id = ?");

  const campaigns = allCampaigns.slice(0, MAX_CAMPAIGNS).map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    budgetId: c.budget_id,
    budgetMicros: c.budget_id ? (budgetById.get(c.budget_id)?.amount_micros ?? null) : null,
    cost7dMicros: (cost.get(c.id, windowStart, windowEnd) as { n: number }).n,
    adGroups: (adGroupCount.get(c.id) as { n: number }).n,
  }));

  return {
    ok: true,
    worldNowMs,
    customer: {
      id: customer.id,
      descriptiveName: customer.descriptive_name,
      currencyCode: customer.currency_code,
      timeZone: customer.time_zone,
      ownerEmail: getOwnerEmail(db),
    },
    campaigns,
    budgets: allBudgets
      .slice(0, MAX_BUDGETS)
      .map((b) => ({ id: b.id, name: b.name, amountMicros: b.amount_micros })),
    truncated: allCampaigns.length > MAX_CAMPAIGNS || allBudgets.length > MAX_BUDGETS,
  };
}
