import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listCalendarSummaries } from "@/lib/ui/views";
import { getOwnerEmail } from "@/lib/store/meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const db = getDb();
  return NextResponse.json({
    ownerEmail: getOwnerEmail(db),
    calendars: listCalendarSummaries(db),
  });
}
