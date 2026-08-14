import { describe, expect, it } from "vitest";
import { logAction, listActions } from "@/lib/audit";
import { newBudgetId, newRequestId } from "@/lib/googleads/ids";
import { budgetIsAttached, getBudget, updateBudget } from "@/lib/store/budgets";
import { getCampaign, removeCampaign } from "@/lib/store/campaigns";
import { countStatRows } from "@/lib/store/stats";
import { countAdGroups } from "@/lib/store/adGroups";
import { BUDGET_OVER, BUDGET_QUIET, CAMPAIGN_OVER, makeTestDb } from "./helpers";

describe("schema", () => {
  it("has every table the API reads", () => {
    const db = makeTestDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const table of ["meta", "customers", "campaign_budgets", "campaigns", "ad_groups", "daily_stats"]) {
      expect(names).toContain(table);
    }
    // sessions/action_log live on the ATTACHed alias, not in the main database.
    const audit = (
      db.prepare("SELECT name FROM audit.sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(audit).toContain("sessions");
    expect(audit).toContain("action_log");
  });

  it("uses idx_daily_stats_date for the report's date-window scan", () => {
    const db = makeTestDb();
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT SUM(cost_micros) FROM daily_stats WHERE date BETWEEN ? AND ? GROUP BY campaign_id",
      )
      .all("2026-07-27", "2026-08-02") as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join(" ")).toContain("idx_daily_stats_date");
  });

  it("cascades a deleted campaign to its ad groups and stats", () => {
    const db = makeTestDb();
    db.pragma("foreign_keys = ON");
    expect(countAdGroups(db)).toBe(4);
    db.prepare("DELETE FROM campaigns WHERE id = ?").run(CAMPAIGN_OVER);
    expect(countAdGroups(db)).toBe(2);
    expect(countStatRows(db)).toBe(5);
  });
});

describe("store", () => {
  it("leaves a removed campaign readable with status REMOVED", () => {
    const db = makeTestDb();
    removeCampaign(db, CAMPAIGN_OVER);
    const row = getCampaign(db, CAMPAIGN_OVER);
    expect(row?.status).toBe("REMOVED");
    expect(row?.name).toBe("Acme — Payments Integration (Search)");
  });

  it("applies only the keys present in a budget patch", () => {
    const db = makeTestDb();
    updateBudget(db, BUDGET_OVER, { amountMicros: 400_000_000 });
    const row = getBudget(db, BUDGET_OVER);
    expect(row?.amount_micros).toBe(400_000_000);
    expect(row?.name).toBe("Payments daily budget");
    expect(row?.delivery_method).toBe("STANDARD");
  });

  it("reports a budget as attached only while a live campaign points at it", () => {
    const db = makeTestDb();
    expect(budgetIsAttached(db, BUDGET_OVER)).toBe(true);
    removeCampaign(db, CAMPAIGN_OVER);
    expect(budgetIsAttached(db, BUDGET_OVER)).toBe(false);
    // The paused campaign still counts: paused is not removed.
    expect(budgetIsAttached(db, BUDGET_QUIET)).toBe(true);
  });

  it("mints ids in Google's alphabets", () => {
    expect(newBudgetId()).toMatch(/^[1-9]\d{10}$/);
    expect(newRequestId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("audit atomicity", () => {
  const entry = {
    method: "POST",
    endpoint: "/v17/customers/4802938157/campaigns:mutate",
    actionType: "campaignUpdate",
    targetType: "campaign",
    targetId: CAMPAIGN_OVER,
    summary: "Paused “Acme — Payments Integration (Search)”",
  };

  it("leaves no action_log row when the transaction throws", () => {
    const db = makeTestDb();
    const tx = db.transaction(() => {
      removeCampaign(db, CAMPAIGN_OVER);
      logAction(db, entry);
      throw new Error("boom");
    });
    expect(() => tx()).toThrow("boom");
    expect(listActions(db)).toHaveLength(0);
    // And the mutation rolled back with it — the evidence and the change are one.
    expect(getCampaign(db, CAMPAIGN_OVER)?.status).toBe("ENABLED");
  });

  it("leaves exactly one action_log row when it commits", () => {
    const db = makeTestDb();
    db.transaction(() => {
      removeCampaign(db, CAMPAIGN_OVER);
      logAction(db, entry);
    })();
    const rows = listActions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toContain("Paused");
    expect(getCampaign(db, CAMPAIGN_OVER)?.status).toBe("REMOVED");
  });
});
