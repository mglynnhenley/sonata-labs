import { handleCalendar, json } from "@/lib/calendar/route-helpers";
import { listCalendarRows } from "@/lib/store/calendars";
import { shapeCalendarListEntry, etagFor } from "@/lib/calendar/shape";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// calendarList.list — the SDK's entry point. Google hardcodes `me` in the path
// (there is no other userId), so this route is static.
export async function GET(req: Request) {
  return handleCalendar(req, ({ db }) => {
    const items = listCalendarRows(db).map(shapeCalendarListEntry);
    return json({
      kind: "calendar#calendarList",
      etag: etagFor(items.length, "calendarList"),
      nextSyncToken: etagFor(items.length, "sync").replace(/"/g, ""),
      items,
    });
  });
}
