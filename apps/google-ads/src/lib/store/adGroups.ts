import type { Database } from "better-sqlite3";

// Ad groups. Read-only through the API this phase, but they are the grain
// daily_stats is stored at, so every metric in the clone comes from a row that
// points at one of these.

export interface AdGroupRow {
  id: string;
  customer_id: string;
  campaign_id: string;
  name: string;
  status: string;
  type: string;
  cpc_bid_micros: number | null;
  is_sandbox_created: number;
}

export interface InsertAdGroupInput {
  id: string;
  customerId: string;
  campaignId: string;
  name: string;
  status?: string;
  type?: string;
  cpcBidMicros?: number | null;
  isSandboxCreated?: boolean;
}

export function getAdGroup(db: Database, id: string): AdGroupRow | null {
  return (db.prepare("SELECT * FROM ad_groups WHERE id = ?").get(id) as AdGroupRow) ?? null;
}

export function insertAdGroup(db: Database, input: InsertAdGroupInput): AdGroupRow {
  db.prepare(
    `INSERT INTO ad_groups
       (id, customer_id, campaign_id, name, status, type, cpc_bid_micros, is_sandbox_created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       campaign_id = excluded.campaign_id,
       name = excluded.name,
       status = excluded.status,
       type = excluded.type,
       cpc_bid_micros = excluded.cpc_bid_micros`,
  ).run(
    input.id,
    input.customerId,
    input.campaignId,
    input.name,
    input.status ?? "ENABLED",
    input.type ?? "SEARCH_STANDARD",
    input.cpcBidMicros ?? null,
    input.isSandboxCreated ? 1 : 0,
  );
  const row = getAdGroup(db, input.id);
  if (!row) throw new Error(`ad group ${input.id} vanished after insert`);
  return row;
}

export function countAdGroups(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ad_groups").get() as { n: number }).n;
}
