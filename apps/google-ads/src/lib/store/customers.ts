import type { Database } from "better-sqlite3";

// The advertiser account. Exactly one row lives here — the sandbox clones a
// single account, which is why getOnlyCustomer() is the accessor every caller
// wants and why listAccessibleCustomers has one entry to return.

export interface CustomerRow {
  id: string;
  descriptive_name: string;
  currency_code: string;
  time_zone: string;
}

export interface InsertCustomerInput {
  id: string;
  descriptiveName: string;
  currencyCode?: string;
  timeZone?: string;
}

export function getCustomer(db: Database, id: string): CustomerRow | null {
  return (db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as CustomerRow) ?? null;
}

export function getOnlyCustomer(db: Database): CustomerRow | null {
  return (db.prepare("SELECT * FROM customers LIMIT 1").get() as CustomerRow) ?? null;
}

/** Upsert, so re-seeding the same account twice is a no-op rather than a clash. */
export function insertCustomer(db: Database, input: InsertCustomerInput): CustomerRow {
  db.prepare(
    `INSERT INTO customers (id, descriptive_name, currency_code, time_zone)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       descriptive_name = excluded.descriptive_name,
       currency_code = excluded.currency_code,
       time_zone = excluded.time_zone`,
  ).run(input.id, input.descriptiveName, input.currencyCode ?? "USD", input.timeZone ?? "America/New_York");
  const row = getCustomer(db, input.id);
  if (!row) throw new Error(`customer ${input.id} vanished after insert`);
  return row;
}
