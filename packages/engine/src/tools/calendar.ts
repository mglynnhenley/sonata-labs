import type { TwinHttp } from "../http";
import { fn, int, str, strList, type EngineTool, type ToolInput } from "./types";

// The seven calendar tools. Read four ways (calendars, events in a window, one
// event, free time), write three (create, update, cancel).
//
// `find_free_time` is the one tool here that is not a thin wrapper: freeBusy
// answers with busy blocks, and an agent asked to "find half an hour" that has to
// invert those blocks itself gets it wrong — off-by-one at the boundaries, or it
// proposes a slot inside a meeting it was just told about. Inverting them here
// makes the failure mode "it picked a bad time", which is judgement, rather than
// "it cannot subtract intervals", which is arithmetic and not what is under test.

/** Slot floor. Anything shorter is not a meeting, it is a gap between two. */
const MIN_SLOT_MINUTES = 5;

/** Free windows returned per query — an agent needs options, not a calendar dump. */
const MAX_FREE = 12;

const MAX_EVENTS = 50;

const MAX_DESCRIPTION = 1000;

interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface EventResource {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  organizer?: { email?: string; displayName?: string };
  attendees?: Array<{ email?: string; responseStatus?: string; displayName?: string }>;
}

function when(v: EventDateTime | undefined): string {
  return v?.dateTime ?? v?.date ?? "";
}

function describe(e: EventResource): Record<string, unknown> {
  return {
    id: e.id,
    summary: e.summary ?? "",
    start: when(e.start),
    end: when(e.end),
    status: e.status ?? "confirmed",
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { description: e.description.slice(0, MAX_DESCRIPTION) } : {}),
    organizer: e.organizer?.email ?? "",
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email ?? "",
      response: a.responseStatus ?? "needsAction",
    })),
  };
}

interface Block {
  start: number;
  end: number;
}

/**
 * The gaps between busy blocks inside `[from, to)`, merged and floored. Pure, so
 * the interval arithmetic the agent is spared can be asserted on its own.
 */
export function freeWindows(busy: Block[], from: number, to: number, minMs: number): Block[] {
  const merged: Block[] = [];
  for (const b of [...busy].sort((a, z) => a.start - z.start)) {
    const clamped = { start: Math.max(b.start, from), end: Math.min(b.end, to) };
    if (clamped.end <= clamped.start) continue;
    const last = merged[merged.length - 1];
    // Touching blocks merge: back-to-back meetings leave no gap, and reporting a
    // zero-length one as free is how an agent books over a handover.
    if (last && clamped.start <= last.end) last.end = Math.max(last.end, clamped.end);
    else merged.push(clamped);
  }

  const free: Block[] = [];
  let cursor = from;
  for (const b of merged) {
    if (b.start - cursor >= minMs) free.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (to - cursor >= minMs) free.push({ start: cursor, end: to });
  return free;
}

export function calendarTools(http: TwinHttp): EngineTool[] {
  const api = "/calendar/v3";
  let primaryId: string | undefined;

  /** The owner's own calendar, which is what an unqualified request means. */
  async function primary(): Promise<string> {
    if (!primaryId) {
      const list = await http.get<{ items?: Array<{ id?: string; primary?: boolean }> }>(
        `${api}/users/me/calendarList`,
      );
      const items = list.items ?? [];
      primaryId = items.find((c) => c.primary)?.id ?? items[0]?.id ?? "primary";
    }
    return primaryId;
  }

  async function calendarFor(input: ToolInput): Promise<string> {
    const given = str(input.calendarId);
    return given ? given : await primary();
  }

  function eventPath(calendarId: string, eventId: string): string {
    return `${api}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  }

  /** Google's shape for a moment; the twin accepts nothing else on a write. */
  function bound(iso: string): EventDateTime {
    return { dateTime: iso };
  }

  return [
    {
      name: "list_calendars",
      twin: "calendar",
      isMutation: false,
      def: fn(
        "list_calendars",
        "List the calendars you can see, and which one is the owner's own.",
        { type: "object", properties: {} },
      ),
      async run() {
        const list = await http.get<{
          items?: Array<{ id?: string; summary?: string; primary?: boolean }>;
        }>(`${api}/users/me/calendarList`);
        return {
          calendars: (list.items ?? []).map((c) => ({
            id: c.id,
            summary: c.summary ?? "",
            primary: c.primary === true,
          })),
        };
      },
    },
    {
      name: "list_events",
      twin: "calendar",
      isMutation: false,
      def: fn(
        "list_events",
        "List the events in a time window, earliest first. Look here before you promise " +
          "anyone a time.",
        {
          type: "object",
          properties: {
            timeMin: { type: "string", description: "RFC3339 start of the window." },
            timeMax: { type: "string", description: "RFC3339 end of the window." },
            q: { type: "string", description: "Free-text filter on title and description." },
            calendarId: { type: "string", description: "Defaults to the owner's calendar." },
            maxResults: { type: "integer", description: "Default 25." },
          },
          required: ["timeMin", "timeMax"],
        },
      ),
      async run(input: ToolInput) {
        const calendarId = await calendarFor(input);
        const res = await http.get<{ items?: EventResource[] }>(
          `${api}/calendars/${encodeURIComponent(calendarId)}/events`,
          {
            timeMin: str(input.timeMin),
            timeMax: str(input.timeMax),
            ...(str(input.q) ? { q: str(input.q) } : {}),
            // Expanded and ordered: a recurring meeting has to show as the
            // instance that falls in the window, not as an unplaceable master.
            singleEvents: true,
            orderBy: "startTime",
            maxResults: Math.min(int(input.maxResults, 25), MAX_EVENTS),
          },
        );
        return { calendarId, events: (res.items ?? []).map(describe) };
      },
    },
    {
      name: "get_event",
      twin: "calendar",
      isMutation: false,
      def: fn(
        "get_event",
        "Read one event in full: times, location, description, and who has answered.",
        {
          type: "object",
          properties: {
            eventId: { type: "string" },
            calendarId: { type: "string", description: "Defaults to the owner's calendar." },
          },
          required: ["eventId"],
        },
      ),
      async run(input: ToolInput) {
        const calendarId = await calendarFor(input);
        const event = await http.get<EventResource>(eventPath(calendarId, str(input.eventId)));
        return { calendarId, ...describe(event) };
      },
    },
    {
      name: "find_free_time",
      twin: "calendar",
      isMutation: false,
      def: fn(
        "find_free_time",
        "Find the windows in which everyone named is free. Returns actual free slots, not " +
          "busy blocks — use it before proposing a meeting time.",
        {
          type: "object",
          properties: {
            timeMin: { type: "string", description: "RFC3339 start of the search window." },
            timeMax: { type: "string", description: "RFC3339 end of the search window." },
            attendees: {
              type: "array",
              items: { type: "string" },
              description: "Email addresses. The owner's own calendar is always included.",
            },
            durationMinutes: { type: "integer", description: "Shortest useful slot. Default 30." },
          },
          required: ["timeMin", "timeMax"],
        },
      ),
      async run(input: ToolInput) {
        const calendarId = await calendarFor(input);
        const ids = [calendarId, ...strList(input.attendees)];
        const res = await http.post<{
          calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }> }>;
        }>(`${api}/freeBusy`, {
          timeMin: str(input.timeMin),
          timeMax: str(input.timeMax),
          items: [...new Set(ids)].map((id) => ({ id })),
        });

        const busy: Block[] = [];
        for (const entry of Object.values(res.calendars ?? {})) {
          for (const b of entry.busy ?? []) {
            const start = Date.parse(str(b.start));
            const end = Date.parse(str(b.end));
            if (Number.isFinite(start) && Number.isFinite(end)) busy.push({ start, end });
          }
        }

        const from = Date.parse(str(input.timeMin));
        const to = Date.parse(str(input.timeMax));
        if (!Number.isFinite(from) || !Number.isFinite(to)) {
          throw new Error("timeMin and timeMax must be RFC3339 instants");
        }
        const minMs = Math.max(int(input.durationMinutes, 30), MIN_SLOT_MINUTES) * 60_000;
        return {
          free: freeWindows(busy, from, to, minMs)
            .slice(0, MAX_FREE)
            .map((w) => ({
              start: new Date(w.start).toISOString(),
              end: new Date(w.end).toISOString(),
            })),
        };
      },
    },
    {
      name: "create_event",
      twin: "calendar",
      isMutation: true,
      def: fn(
        "create_event",
        "Put a meeting on the calendar and invite people to it. Check free time first — " +
          "double-booking someone is worse than asking.",
        {
          type: "object",
          properties: {
            summary: { type: "string", description: "The meeting's title." },
            start: { type: "string", description: "RFC3339 start." },
            end: { type: "string", description: "RFC3339 end." },
            attendees: { type: "array", items: { type: "string" }, description: "Email addresses." },
            description: { type: "string" },
            location: { type: "string" },
            calendarId: { type: "string", description: "Defaults to the owner's calendar." },
          },
          required: ["summary", "start", "end"],
        },
      ),
      async run(input: ToolInput) {
        const calendarId = await calendarFor(input);
        const event = await http.post<EventResource>(
          `${api}/calendars/${encodeURIComponent(calendarId)}/events`,
          {
            summary: str(input.summary),
            start: bound(str(input.start)),
            end: bound(str(input.end)),
            ...(str(input.description) ? { description: str(input.description) } : {}),
            ...(str(input.location) ? { location: str(input.location) } : {}),
            attendees: strList(input.attendees).map((email) => ({ email })),
          },
        );
        return { calendarId, id: event.id, summary: event.summary, start: when(event.start) };
      },
    },
    {
      name: "update_event",
      twin: "calendar",
      isMutation: true,
      def: fn(
        "update_event",
        "Change an existing event — move it, retitle it, or change who is invited. Only the " +
          "fields you send are changed.",
        {
          type: "object",
          properties: {
            eventId: { type: "string" },
            summary: { type: "string" },
            start: { type: "string", description: "RFC3339. Send both start and end to move it." },
            end: { type: "string" },
            attendees: {
              type: "array",
              items: { type: "string" },
              description: "Replaces the whole guest list — include everyone who stays.",
            },
            description: { type: "string" },
            location: { type: "string" },
            calendarId: { type: "string" },
          },
          required: ["eventId"],
        },
      ),
      async run(input: ToolInput) {
        const calendarId = await calendarFor(input);
        const attendees = strList(input.attendees);
        const event = await http.patch<EventResource>(
          eventPath(calendarId, str(input.eventId)),
          {
            ...(str(input.summary) ? { summary: str(input.summary) } : {}),
            ...(str(input.start) ? { start: bound(str(input.start)) } : {}),
            ...(str(input.end) ? { end: bound(str(input.end)) } : {}),
            ...(str(input.description) ? { description: str(input.description) } : {}),
            ...(str(input.location) ? { location: str(input.location) } : {}),
            ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
          },
        );
        return { calendarId, id: event.id, summary: event.summary, start: when(event.start) };
      },
    },
    {
      name: "delete_event",
      twin: "calendar",
      isMutation: true,
      def: fn(
        "delete_event",
        "Cancel a meeting. Everyone invited sees it disappear, so say why somewhere first.",
        {
          type: "object",
          properties: { eventId: { type: "string" }, calendarId: { type: "string" } },
          required: ["eventId"],
        },
      ),
      async run(input: ToolInput) {
        const calendarId = await calendarFor(input);
        const eventId = str(input.eventId);
        await http.delete(eventPath(calendarId, eventId));
        return { calendarId, eventId, cancelled: true };
      },
    },
  ];
}
