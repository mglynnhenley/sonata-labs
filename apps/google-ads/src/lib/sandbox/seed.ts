import { startNewSession } from "../audit";
import { applySchema, getDb } from "../db";
import { snapshotWorking } from "../reset";
import { countAdGroups, insertAdGroup } from "../store/adGroups";
import { countBudgets, insertBudget } from "../store/budgets";
import { countCampaigns, insertCampaign } from "../store/campaigns";
import { insertCustomer } from "../store/customers";
import { setMeta } from "../store/meta";
import { countStatRows, insertDailyStat } from "../store/stats";
import type { ParsedSeed, SeedResult } from "./types";

// Loading a cloned advertiser account.
//
// Total, never additive: the previous account is deleted outright, because an
// account carrying two companies' campaigns is a world no episode described and
// no report can make sense of. Everything is written verbatim — the seed's own
// ids, dates and micros — so the campaign the director later pauses by id is the
// campaign the seed created.
//
// Snapshot handling mirrors the other twins: with `promoteToSnapshot` the seeded
// state becomes what every later `reset` in the run returns to.

export function seedFromWire(seed: ParsedSeed): SeedResult {
  let db = getDb();
  // Idempotent, and it makes a working.db that was never `db:init`ed seedable.
  applySchema(db);

  const write = db.transaction(() => {
    // Child-first, because the foreign keys are ON and a campaign still holding
    // stat rows cannot go.
    db.prepare("DELETE FROM daily_stats").run();
    db.prepare("DELETE FROM ad_groups").run();
    db.prepare("DELETE FROM campaigns").run();
    db.prepare("DELETE FROM campaign_budgets").run();
    db.prepare("DELETE FROM customers").run();
    db.prepare("DELETE FROM meta").run();

    setMeta(db, "owner_email", seed.ownerEmail);
    setMeta(db, "owner_name", seed.ownerName);
    setMeta(db, "customer_id", seed.customer.id);
    // Authored at the world's instant, not at wall-clock time: re-seeding the
    // same world twice has to produce the same LAST_7_DAYS report.
    setMeta(db, "world_now_ms", String(seed.nowMs));
    setMeta(db, "seeded_at", String(seed.nowMs));

    insertCustomer(db, {
      id: seed.customer.id,
      descriptiveName: seed.customer.descriptiveName,
      currencyCode: seed.customer.currencyCode,
      timeZone: seed.customer.timezone,
    });

    for (const budget of seed.budgets) {
      insertBudget(db, {
        id: budget.id,
        customerId: seed.customer.id,
        name: budget.name,
        amountMicros: budget.amountMicros,
        deliveryMethod: budget.deliveryMethod,
        explicitlyShared: budget.explicitlyShared,
        // Seeded history belongs to the world; only the agent's own writes carry
        // the sandbox-created flag the judge reads.
        isSandboxCreated: false,
      });
    }

    for (const campaign of seed.campaigns) {
      insertCampaign(db, {
        id: campaign.id,
        customerId: seed.customer.id,
        budgetId: campaign.budgetId,
        name: campaign.name,
        status: campaign.status,
        advertisingChannelType: campaign.advertisingChannelType,
        biddingStrategyType: campaign.biddingStrategyType,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        isSandboxCreated: false,
      });
    }

    for (const adGroup of seed.adGroups) {
      insertAdGroup(db, {
        id: adGroup.id,
        customerId: seed.customer.id,
        campaignId: adGroup.campaignId,
        name: adGroup.name,
        status: adGroup.status,
        type: adGroup.type,
        cpcBidMicros: adGroup.cpcBidMicros,
        isSandboxCreated: false,
      });
    }

    const campaignOf = new Map(seed.adGroups.map((a) => [a.id, a.campaignId]));
    for (const stat of seed.dailyStats) {
      insertDailyStat(db, {
        customerId: seed.customer.id,
        campaignId: campaignOf.get(stat.adGroupId) as string,
        adGroupId: stat.adGroupId,
        date: stat.date,
        impressions: stat.impressions,
        clicks: stat.clicks,
        costMicros: stat.costMicros,
        conversions: stat.conversions,
        conversionsValue: stat.conversionsValue,
      });
    }
  });

  write();
  const counts = {
    campaigns: countCampaigns(db),
    adGroups: countAdGroups(db),
    budgets: countBudgets(db),
    statRows: countStatRows(db),
  };

  // Closes and reopens the working handle, so nothing may hold `db` past here.
  if (seed.promoteToSnapshot) snapshotWorking();
  db = getDb();

  // A new world deserves a new audit session: the trail the judge reads must not
  // begin in the middle of the company that was here before.
  startNewSession(db, `seeded ${seed.businessName}`, seed.nowMs);

  return { ok: true, counts };
}
