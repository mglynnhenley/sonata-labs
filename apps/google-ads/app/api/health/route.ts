import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { countCampaigns } from "@/lib/store/campaigns";
import { countAdGroups } from "@/lib/store/adGroups";
import { countBudgets } from "@/lib/store/budgets";
import { countStatRows } from "@/lib/store/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness + counts, ungated. The engine's preflight tests `res.status === "ok"`
// literally and renders every other numeric field as "<n> <key>", so the counts
// must be numbers and `time` is the one key it skips. A missing database answers
// with the error rather than throwing — a twin that cannot say why it is unwell
// is indistinguishable from a twin that is down.
export function GET() {
  try {
    const db = getDb();
    return NextResponse.json({
      status: "ok",
      campaigns: countCampaigns(db),
      adGroups: countAdGroups(db),
      budgets: countBudgets(db),
      statRows: countStatRows(db),
      time: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 500 });
  }
}
