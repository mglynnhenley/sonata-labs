import type { Database } from "better-sqlite3";

// Campaigns — the thing the agent pauses.

export interface CampaignRow {
  id: string;
  customer_id: string;
  budget_id: string | null;
  name: string;
  status: string;
  advertising_channel_type: string;
  bidding_strategy_type: string;
  start_date: string;
  end_date: string | null;
  is_sandbox_created: number;
}

export interface InsertCampaignInput {
  id: string;
  customerId: string;
  budgetId?: string | null;
  name: string;
  status?: string;
  advertisingChannelType?: string;
  biddingStrategyType?: string;
  startDate: string;
  endDate?: string | null;
  isSandboxCreated?: boolean;
}

/** The keys a mutate may change; anything absent is left exactly as it was. */
export interface CampaignPatch {
  name?: string;
  status?: string;
  startDate?: string;
  endDate?: string | null;
  budgetId?: string;
}

export function listCampaigns(db: Database, customerId: string): CampaignRow[] {
  return db
    .prepare("SELECT * FROM campaigns WHERE customer_id = ? ORDER BY id")
    .all(customerId) as CampaignRow[];
}

export function getCampaign(db: Database, id: string): CampaignRow | null {
  return (db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as CampaignRow) ?? null;
}

export function insertCampaign(db: Database, input: InsertCampaignInput): CampaignRow {
  db.prepare(
    `INSERT INTO campaigns
       (id, customer_id, budget_id, name, status, advertising_channel_type, bidding_strategy_type,
        start_date, end_date, is_sandbox_created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       budget_id = excluded.budget_id,
       name = excluded.name,
       status = excluded.status,
       advertising_channel_type = excluded.advertising_channel_type,
       bidding_strategy_type = excluded.bidding_strategy_type,
       start_date = excluded.start_date,
       end_date = excluded.end_date`,
  ).run(
    input.id,
    input.customerId,
    input.budgetId ?? null,
    input.name,
    input.status ?? "ENABLED",
    input.advertisingChannelType ?? "SEARCH",
    input.biddingStrategyType ?? "TARGET_SPEND",
    input.startDate,
    input.endDate ?? null,
    input.isSandboxCreated ? 1 : 0,
  );
  const row = getCampaign(db, input.id);
  if (!row) throw new Error(`campaign ${input.id} vanished after insert`);
  return row;
}

export function updateCampaign(db: Database, id: string, patch: CampaignPatch): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    params.push(patch.name);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.startDate !== undefined) {
    sets.push("start_date = ?");
    params.push(patch.startDate);
  }
  if (patch.endDate !== undefined) {
    sets.push("end_date = ?");
    params.push(patch.endDate);
  }
  if (patch.budgetId !== undefined) {
    sets.push("budget_id = ?");
    params.push(patch.budgetId);
  }
  if (!sets.length) return;
  db.prepare(`UPDATE campaigns SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
}

/**
 * Google soft-deletes a campaign: the row stays REMOVED and stays queryable. An
 * agent that removed one and then could not find it would learn something false
 * about the real API.
 */
export function removeCampaign(db: Database, id: string): void {
  db.prepare("UPDATE campaigns SET status = 'REMOVED' WHERE id = ?").run(id);
}

export function countCampaigns(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM campaigns").get() as { n: number }).n;
}
