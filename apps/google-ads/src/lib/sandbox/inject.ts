import type { Database } from "better-sqlite3";
import { formatInZone, DATE_RE } from "../googleads/dates";
import { lookupField, resourceNameFor } from "../googleads/resources";
import { getOnlyCustomer } from "../store/customers";
import { getBudget, updateBudget } from "../store/budgets";
import { getCampaign, updateCampaign } from "../store/campaigns";
import { setWorldNowMs } from "../store/meta";
import { upsertSpend } from "../store/stats";
import { BadRequestError } from "./auth";

// The director's hand on the account: yesterday's spend lands, a budget moves,
// or a campaign flips status behind the agent's back.
//
// Deliberately NOT audit-logged — injection is scenario setup, not agent
// behaviour, and the judge reads the audit log to score the agent. Injected rows
// carry is_sandbox_created = 0 so they are indistinguishable from seed.
//
// Advancing `world_now_ms` is what makes DURING TODAY move; without it the whole
// account is frozen on the day it was seeded and every beat lands in the past.

export interface InjectSpend {
  adGroupId: string;
  date?: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions?: number;
  conversionsValue?: number;
}

export interface InjectBody {
  spend?: InjectSpend[];
  budgetChanges?: Array<{ budgetId: string; amountMicros: number }>;
  statusChanges?: Array<{ campaignId: string; status: string }>;
  atMs?: number;
  atISO?: string;
}

export interface InjectResult {
  twin: "google-ads";
  spendRows: number;
  budgetChanges: Array<{ budgetId: string; resourceName: string }>;
  statusChanges: Array<{ campaignId: string; resourceName: string }>;
  worldNowMs: number;
}

/**
 * Simulated time, never wall-clock. A spend row stamped with the real clock
 * inside a simulated Monday makes the whole account incoherent to the agent
 * reading it, so the absence of both fields is an error and not a default.
 */
export function resolveAt(body: InjectBody, what: string): number {
  if (typeof body.atMs === "number" && Number.isFinite(body.atMs)) return body.atMs;
  if (typeof body.atISO === "string") {
    const ms = Date.parse(body.atISO);
    if (!Number.isNaN(ms)) return ms;
    throw new BadRequestError(`${what}: atISO "${body.atISO}" is not an ISO 8601 timestamp`);
  }
  throw new BadRequestError(`${what}: atMs or atISO is required`);
}

export function injectBeat(db: Database, body: InjectBody): InjectResult {
  const spend = body.spend ?? [];
  const budgetChanges = body.budgetChanges ?? [];
  const statusChanges = body.statusChanges ?? [];
  if (!spend.length && !budgetChanges.length && !statusChanges.length) {
    throw new BadRequestError("nothing to inject — send spend, budgetChanges or statusChanges");
  }

  const atMs = resolveAt(body, "inject");
  const customer = getOnlyCustomer(db);
  if (!customer) throw new BadRequestError("no advertiser account — seed first");

  const statuses = lookupField("campaign.status")?.enumValues ?? [];
  const touchedBudgets: InjectResult["budgetChanges"] = [];
  const touchedCampaigns: InjectResult["statusChanges"] = [];

  const apply = db.transaction(() => {
    // First, so every date defaulted below is the world's date and not the last one.
    setWorldNowMs(db, atMs);
    const today = formatInZone(atMs, customer.time_zone);

    for (const row of spend) {
      const date = row.date ?? today;
      if (!DATE_RE.test(date)) throw new BadRequestError(`spend date "${date}" must be YYYY-MM-DD`);
      // Upserts on (ad_group, date), so replaying a beat replaces the day rather
      // than doubling it.
      upsertSpend(db, { ...row, date });
    }

    for (const change of budgetChanges) {
      if (!getBudget(db, change.budgetId)) {
        throw new BadRequestError(`unknown budget ${change.budgetId}`);
      }
      updateBudget(db, change.budgetId, { amountMicros: change.amountMicros });
      touchedBudgets.push({
        budgetId: change.budgetId,
        resourceName: resourceNameFor("campaign_budget", customer.id, change.budgetId),
      });
    }

    for (const change of statusChanges) {
      if (!getCampaign(db, change.campaignId)) {
        throw new BadRequestError(`unknown campaign ${change.campaignId}`);
      }
      if (!statuses.includes(change.status)) {
        throw new BadRequestError(
          `statusChanges status "${change.status}" must be one of ${statuses.join(", ")}`,
        );
      }
      updateCampaign(db, change.campaignId, { status: change.status });
      touchedCampaigns.push({
        campaignId: change.campaignId,
        resourceName: resourceNameFor("campaign", customer.id, change.campaignId),
      });
    }
  });

  apply();

  return {
    twin: "google-ads",
    spendRows: spend.length,
    budgetChanges: touchedBudgets,
    statusChanges: touchedCampaigns,
    worldNowMs: atMs,
  };
}
