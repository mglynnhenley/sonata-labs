import { NextResponse } from "next/server";
import { listCompanies } from "@/lib/engine/clone";
import { allTwinStatuses } from "@/lib/twins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Everything the Companies page shows, in one response: the cloned businesses,
// which of them is in the clones right now, and whether the clones are even
// answering. One call because those three facts are read together — a card that
// says "In the clones" beside a Gmail that is off is the lie this page exists to
// stop telling.

export async function GET() {
  try {
    const clones = await allTwinStatuses();
    // `at` is the server's clock, so "cloned 3 d ago" is measured against the
    // machine that holds the records rather than whatever the browser thinks.
    return NextResponse.json({ companies: listCompanies(), clones, at: Date.now() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
