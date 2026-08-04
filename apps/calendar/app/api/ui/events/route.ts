import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { buildWeekView } from "@/lib/ui/views";
import { parseRfc3339 } from "@/lib/calendar/time";
import { getDefaultTimeZone } from "@/lib/store/meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WEEK_MS = 7 * 24 * 3600_000;

// Feeds the week grid. `start`/`end` accept RFC3339 or epoch ms; with neither,
// the window is the week around now.
export function GET(req: Request) {
  const db = getDb();
  const sp = new URL(req.url).searchParams;
  const zone = getDefaultTimeZone(db);

  const bound = (raw: string | null): number | null => {
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return Number(raw);
    return parseRfc3339(raw, zone);
  };

  const windowStartMs = bound(sp.get("start")) ?? Date.now() - WEEK_MS / 2;
  const windowEndMs = bound(sp.get("end")) ?? windowStartMs + WEEK_MS;
  if (windowEndMs <= windowStartMs) {
    return NextResponse.json({ error: "end must be after start" }, { status: 400 });
  }

  return NextResponse.json(
    buildWeekView(db, {
      windowStartMs,
      windowEndMs,
      calendarId: sp.get("calendarId") || undefined,
      q: sp.get("q") || undefined,
    }),
  );
}
