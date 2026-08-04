import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { countEvents } from "@/lib/store/events";
import { countCalendars } from "@/lib/store/calendars";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    const db = getDb();
    return NextResponse.json({
      status: "ok",
      events: countEvents(db),
      calendars: countCalendars(db),
      time: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ status: "error", error: (err as Error).message }, { status: 500 });
  }
}
