import { handleCalendar, json } from "@/lib/calendar/route-helpers";
import { CalendarError } from "@/lib/calendar/errors";
import { busyBlocks } from "@/lib/calendar/freebusy";
import { declinedEventIds, listEventRows } from "@/lib/store/events";
import { resolveCalendar } from "@/lib/store/calendars";
import { formatRfc3339, isValidTimeZone, parseRfc3339 } from "@/lib/calendar/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FreeBusyBody {
  timeMin?: unknown;
  timeMax?: unknown;
  timeZone?: unknown;
  items?: unknown;
}

interface FreeBusyCalendar {
  busy: Array<{ start: string; end: string }>;
  errors?: Array<{ domain: string; reason: string }>;
}

function requireBound(value: unknown, field: string, zone: string): number {
  if (typeof value !== "string" || !value) {
    throw new CalendarError(400, `Missing ${field}.`, "required", "INVALID_ARGUMENT");
  }
  const ms = parseRfc3339(value, zone);
  if (ms === null) {
    throw new CalendarError(
      400,
      `Invalid value for parameter '${field}': ${value}`,
      "invalidParameter",
      "INVALID_ARGUMENT",
    );
  }
  return ms;
}

// freeBusy.query — the endpoint a scheduling agent leans on hardest. Recurrence
// is expanded through the same path events.list uses, so a busy block and the
// meeting behind it can never disagree.
export async function POST(req: Request) {
  return handleCalendar(req, async ({ db, ownerEmail, defaultTimeZone }) => {
    const body = (await req.json().catch(() => ({}))) as FreeBusyBody;
    const zone =
      typeof body.timeZone === "string" && isValidTimeZone(body.timeZone)
        ? body.timeZone
        : defaultTimeZone;

    const timeMinMs = requireBound(body.timeMin, "timeMin", zone);
    const timeMaxMs = requireBound(body.timeMax, "timeMax", zone);
    if (timeMaxMs <= timeMinMs) {
      throw new CalendarError(
        400,
        "The requested time range is empty.",
        "timeRangeEmpty",
        "INVALID_ARGUMENT",
      );
    }

    const items = Array.isArray(body.items) ? body.items : [];
    const calendars: Record<string, FreeBusyCalendar> = {};

    for (const raw of items) {
      const id = (raw as { id?: unknown })?.id;
      if (typeof id !== "string" || !id) continue;
      const calendar = resolveCalendar(db, id);
      if (!calendar) {
        // Google reports per-calendar failures inside the payload, not as a 404.
        calendars[id] = { busy: [], errors: [{ domain: "global", reason: "notFound" }] };
        continue;
      }
      const rows = listEventRows(db, {
        calendarId: calendar.id,
        timeMinMs,
        timeMaxMs,
        includeRecurringMasters: true,
      });
      const declined = declinedEventIds(db, ownerEmail, calendar.id);
      const busy = busyBlocks(rows, timeMinMs, timeMaxMs, calendar.time_zone, declined);
      calendars[id] = {
        busy: busy.map((b) => ({
          start: formatRfc3339(b.startMs, zone),
          end: formatRfc3339(b.endMs, zone),
        })),
      };
    }

    return json({
      kind: "calendar#freeBusy",
      timeMin: formatRfc3339(timeMinMs, zone),
      timeMax: formatRfc3339(timeMaxMs, zone),
      calendars,
    });
  });
}
