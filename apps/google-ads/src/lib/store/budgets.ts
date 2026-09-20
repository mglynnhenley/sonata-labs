import type { Database } from "better-sqlite3";

// Campaign budgets — the thing the "adjust a budget" task mutates. Amounts are
// micros everywhere: a $250/day budget is 250000000, and the column is named for
// the factor so a reader cannot forget it.

export interface BudgetRow {
  id: string;
  customer_id: string;
  name: string;
  amount_micros: number;
  delivery_method: string;
  period: string;
  explicitly_shared: number;
  status: string;
  is_sandbox_created: number;
}

export interface InsertBudgetInput {
  id: string;
  customerId: string;
  name: string;
  amountMicros: number;
  deliveryMethod?: string;
  period?: string;
  explicitlyShared?: boolean;
  status?: string;
  isSandboxCreated?: boolean;
}

/**
 * The keys a mutate may change; anything absent is left exactly as it was.
 * `status` is deliberately not among them: Google has no settable status on a
 * budget, `MUTABLE.campaignBudget` in mutate.ts refuses a mask that names one,
 * and the only way the column ever moves is `removeBudget` below.
 */
export interface BudgetPatch {
  name?: string;
  amountMicros?: number;
  deliveryMethod?: string;
  explicitlyShared?: boolean;
}

export function listBudgets(db: Database, customerId: string): BudgetRow[] {
  return db
    .prepare("SELECT * FROM campaign_budgets WHERE customer_id = ? ORDER BY id")
    .all(customerId) as BudgetRow[];
}

export function getBudget(db: Database, id: string): BudgetRow | null {
  return (db.prepare("SELECT * FROM campaign_budgets WHERE id = ?").get(id) as BudgetRow) ?? null;
}

export function insertBudget(db: Database, input: InsertBudgetInput): BudgetRow {
  db.prepare(
    `INSERT INTO campaign_budgets
       (id, customer_id, name, amount_micros, delivery_method, period, explicitly_shared, status, is_sandbox_created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       amount_micros = excluded.amount_micros,
       delivery_method = excluded.delivery_method,
       period = excluded.period,
       explicitly_shared = excluded.explicitly_shared,
       status = excluded.status`,
  ).run(
    input.id,
    input.customerId,
    input.name,
    input.amountMicros,
    input.deliveryMethod ?? "STANDARD",
    input.period ?? "DAILY",
    input.explicitlyShared ? 1 : 0,
    input.status ?? "ENABLED",
    input.isSandboxCreated ? 1 : 0,
  );
  const row = getBudget(db, input.id);
  if (!row) throw new Error(`budget ${input.id} vanished after insert`);
  return row;
}

/** Applies only the keys present, so an unmasked field cannot be clobbered. */
export function updateBudget(db: Database, id: string, patch: BudgetPatch): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    params.push(patch.name);
  }
  if (patch.amountMicros !== undefined) {
    sets.push("amount_micros = ?");
    params.push(patch.amountMicros);
  }
  if (patch.deliveryMethod !== undefined) {
    sets.push("delivery_method = ?");
    params.push(patch.deliveryMethod);
  }
  if (patch.explicitlyShared !== undefined) {
    sets.push("explicitly_shared = ?");
    params.push(patch.explicitlyShared ? 1 : 0);
  }
  if (!sets.length) return;
  db.prepare(`UPDATE campaign_budgets SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
}

/** Google soft-deletes: the row stays and stays queryable. */
export function removeBudget(db: Database, id: string): void {
  db.prepare("UPDATE campaign_budgets SET status = 'REMOVED' WHERE id = ?").run(id);
}

/** A live campaign still pointing at it is what makes a removal illegal. */
export function budgetIsAttached(db: Database, id: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM campaigns WHERE budget_id = ? AND status != 'REMOVED' LIMIT 1")
    .get(id);
}

export function countBudgets(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM campaign_budgets").get() as { n: number }).n;
}
