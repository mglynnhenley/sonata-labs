import {
  handleCalendar,
  json,
  requireCalendar,
  runMutation,
} from "@/lib/calendar/route-helpers";
import { CalendarError } from "@/lib/calendar/errors";
import { clampMaxResults, decodePageToken, encodePageToken } from "@/lib/calendar/pagination";
import { listEventResources } from "@/lib/calendar/list";
import { buildInsertInput, type EventBody } from "@/lib/calendar/event-input";
import { etagFor, shapeEvent } from "@/lib/calendar/shape";
import { insertEvent, listAttendees } from "@/lib/store/events";
import { parseRfc3339 } from "@/lib/calendar/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function boundParam(raw: string | null, field: string, zone: string): number | undefined {
  if (!raw) return undefined;
  const ms = parseRfc3339(raw, zone);
  if (ms === null) {
    throw new CalendarError(
      400,
      `Invalid value for parameter '${field}': ${raw}`,
      "invalidParameter",
      "INVALID_ARGUMENT",
    );
  }
  return ms;
}

// events.list
export async function GET(
  req: Request,
  { params }: { params: Promise<{ calendarId: string }> },
) {
  const { calendarId } = await params;
  return handleCalendar(req, ({ db, ownerEmail }) => {
    const calendar = requireCalendar(db, calendarId);
    const sp = new URL(req.url).searchParams;

    const zone = calendar.time_zone;
    const timeMinMs = boundParam(sp.get("timeMin"), "timeMin", zone);
    const timeMaxMs = boundParam(sp.get("timeMax"), "timeMax", zone);
    if (timeMinMs !== undefined && timeMaxMs !== undefined && timeMaxMs < timeMinMs) {
      throw new CalendarError(
        400,
        "The requested time range is empty.",
        "timeRangeEmpty",
        "INVALID_ARGUMENT",
      );
    }

    const singleEvents = sp.get("singleEvents") === "true";
    const orderBy = sp.get("orderBy");
    // Google rejects orderBy=startTime unless the series has been expanded,
    // because unexpanded masters have no single start to sort on.
    if (orderBy === "startTime" && !singleEvents) {
      throw new CalendarError(
        400,
        "The orderBy startTime is only available when querying single events.",
        "cannotOrderBy",
        "INVALID_ARGUMENT",
      );
    }

    const { items, updatedMs } = listEventResources(db, {
      calendar,
      ownerEmail,
      timeMinMs,
      timeMaxMs,
      q: sp.get("q") || undefined,
      singleEvents,
      showDeleted: sp.get("showDeleted") === "true",
    });

    const limit = clampMaxResults(sp.get("maxResults"));
    const { offset } = decodePageToken(sp.get("pageToken"));
    const page = items.slice(offset, offset + limit);

    const body: Record<string, unknown> = {
      kind: "calendar#events",
      etag: etagFor(updatedMs, calendar.id),
      summary: calendar.summary,
      updated: new Date(updatedMs || Date.now()).toISOString(),
      timeZone: calendar.time_zone,
      accessRole: calendar.access_role,
      defaultReminders: [],
      items: page,
    };
    if (calendar.description) body.description = calendar.description;
    // Omit nextPageToken entirely on the last page (never null).
    if (offset + limit < items.length) {
      body.nextPageToken = encodePageToken({ offset: offset + limit });
    } else {
      body.nextSyncToken = encodePageToken({ offset: items.length });
    }
    return json(body);
  });
}

// events.insert
export async function POST(
  req: Request,
  { params }: { params: Promise<{ calendarId: string }> },
) {
  const { calendarId } = await params;
  return handleCalendar(req, async ({ db, ownerEmail }) => {
    const calendar = requireCalendar(db, calendarId);
    const body = (await req.json().catch(() => ({}))) as EventBody;
    const input = buildInsertInput(body, {
      calendarId: calendar.id,
      calendarTimeZone: calendar.time_zone,
      ownerEmail,
      now: Date.now(),
    });
    const endpoint = new URL(req.url).pathname;

    const row = runMutation(
      db,
      () => insertEvent(db, input),
      (r) => ({
        method: "POST",
        endpoint,
        actionType: "eventInsert",
        targetType: "event",
        targetId: r.id,
        request: body,
        responseCode: 200,
        summary: `Created “${r.summary ?? "(no title)"}” on ${calendar.summary}`,
      }),
    );

    return json(
      shapeEvent(row, listAttendees(db, row.id), {
        ownerEmail,
        calendarTimeZone: calendar.time_zone,
      }),
    );
  });
}
