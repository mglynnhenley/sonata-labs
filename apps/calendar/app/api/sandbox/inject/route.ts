import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { checkSandboxToken } from "@/lib/calendar/auth";
import { getOwnerEmail } from "@/lib/store/meta";
import { getPrimaryCalendar, resolveCalendar } from "@/lib/store/calendars";
import {
  cancelEvent,
  getEventRow,
  insertEvent,
  setAttendeeResponse,
  updateEvent,
} from "@/lib/store/events";
import { buildInsertInput, parseAttendees, type EventBody } from "@/lib/calendar/event-input";
import { parseEventDateTime } from "@/lib/calendar/shape";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The director's hand on the calendar: place a meeting, move one, cancel one,
// answer one. Deliberately NOT audit-logged — injection is scenario setup, not
// agent behaviour, and the judge reads the audit log to score the agent.
// Injected events carry is_sandbox_created = 0 so they're indistinguishable
// from seed.
//
// The lack of an audit row is why RSVPs have to come through here at all: the
// public events.patch writes one, so a colleague accepting an invite would be
// filed as something the agent did.
//
// Times accept either an RFC3339 `start`/`end` pair (Google's shape) or the
// friendlier `startMinutesFromNow` + `durationMinutes`, which is what a tick
// loop actually has to hand.

interface InjectEvent extends EventBody {
  slotId?: string;
  calendarId?: string;
  startMinutesFromNow?: number;
  durationMinutes?: number;
}

interface InjectMove {
  calendarId?: string;
  eventId: string;
  start?: unknown;
  end?: unknown;
  shiftMinutes?: number;
}

interface InjectRsvp {
  calendarId?: string;
  eventId: string;
  /** Whoever is answering. Must already be on the event — see the branch below. */
  email: string;
  /** accepted | declined | tentative | needsAction. */
  response?: unknown;
  /** Google's `attendees[].comment` — why. Omitted leaves any existing note alone. */
  comment?: unknown;
}

interface InjectBody {
  events?: InjectEvent[];
  moves?: InjectMove[];
  cancels?: Array<{ calendarId?: string; eventId: string }>;
  rsvps?: InjectRsvp[];
}

function relativeBounds(
  spec: InjectEvent,
  now: number,
  timeZone: string,
): { start: unknown; end: unknown } | null {
  if (spec.startMinutesFromNow === undefined) return null;
  const startMs = now + spec.startMinutesFromNow * 60_000;
  const endMs = startMs + (spec.durationMinutes ?? 30) * 60_000;
  return {
    start: { dateTime: new Date(startMs).toISOString(), timeZone },
    end: { dateTime: new Date(endMs).toISOString(), timeZone },
  };
}

export async function POST(req: Request) {
  const denied = checkSandboxToken(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as InjectBody;
    const events = body.events ?? [];
    const moves = body.moves ?? [];
    const cancels = body.cancels ?? [];
    const rsvps = body.rsvps ?? [];
    if (!events.length && !moves.length && !cancels.length && !rsvps.length) {
      return NextResponse.json({ error: "nothing to inject" }, { status: 400 });
    }

    const db = getDb();
    const ownerEmail = getOwnerEmail(db);
    const primary = getPrimaryCalendar(db);
    if (!primary) {
      return NextResponse.json({ error: "no primary calendar — seed first" }, { status: 409 });
    }
    const now = Date.now();

    const inserted: Array<{ slotId: string; id: string; calendarId: string }> = [];
    const moved: Array<{ id: string; calendarId: string }> = [];
    const cancelled: Array<{ id: string; calendarId: string }> = [];
    const answered: Array<{ id: string; calendarId: string; email: string }> = [];

    const apply = db.transaction(() => {
      for (const spec of events) {
        const calendar = spec.calendarId ? resolveCalendar(db, spec.calendarId) : primary;
        if (!calendar) throw new Error(`unknown calendar ${String(spec.calendarId)}`);
        const relative = relativeBounds(spec, now, calendar.time_zone);
        const input = buildInsertInput(
          relative ? { ...spec, ...relative } : spec,
          {
            calendarId: calendar.id,
            calendarTimeZone: calendar.time_zone,
            ownerEmail,
            now,
          },
        );
        // Injected events belong to the world, not to the agent under test.
        input.isSandboxCreated = false;
        const row = insertEvent(db, input);
        inserted.push({ slotId: spec.slotId ?? row.id, id: row.id, calendarId: calendar.id });
      }

      for (const move of moves) {
        const calendar = move.calendarId ? resolveCalendar(db, move.calendarId) : primary;
        if (!calendar) throw new Error(`unknown calendar ${String(move.calendarId)}`);
        const existing = getEventRow(db, calendar.id, move.eventId);
        if (!existing) throw new Error(`unknown event ${move.eventId}`);
        const duration = existing.end_ms - existing.start_ms;
        let startMs: number;
        let endMs: number;
        if (move.shiftMinutes !== undefined) {
          startMs = existing.start_ms + move.shiftMinutes * 60_000;
          endMs = existing.end_ms + move.shiftMinutes * 60_000;
        } else {
          const zone = existing.start_tz ?? calendar.time_zone;
          const start = parseEventDateTime(move.start, zone);
          if (!start) throw new Error(`move for ${move.eventId} needs start or shiftMinutes`);
          const end = parseEventDateTime(move.end, zone);
          startMs = start.ms;
          endMs = end ? end.ms : start.ms + duration;
        }
        updateEvent(db, calendar.id, move.eventId, { startMs, endMs, updatedMs: now });
        moved.push({ id: move.eventId, calendarId: calendar.id });
      }

      for (const cancel of cancels) {
        const calendar = cancel.calendarId ? resolveCalendar(db, cancel.calendarId) : primary;
        if (!calendar) throw new Error(`unknown calendar ${String(cancel.calendarId)}`);
        cancelEvent(db, calendar.id, cancel.eventId, now);
        cancelled.push({ id: cancel.eventId, calendarId: calendar.id });
      }

      for (const rsvp of rsvps) {
        const calendar = rsvp.calendarId ? resolveCalendar(db, rsvp.calendarId) : primary;
        if (!calendar) throw new Error(`unknown calendar ${String(rsvp.calendarId)}`);
        if (!getEventRow(db, calendar.id, rsvp.eventId)) {
          throw new Error(`unknown event ${rsvp.eventId}`);
        }
        // Not redundant with the parser below, which is why it reads that way:
        // `parseAttendees` DEFAULTS a missing responseStatus to "needsAction" —
        // a fine value on a guest list, and a silent no-op as an answer. Without
        // this line a beat that forgot its response would return 200, count as
        // landed, and put "a change on the calendar" in the agent's digest for a
        // change nobody made.
        if (typeof rsvp.response !== "string") {
          throw new Error(`rsvp for ${rsvp.eventId} needs a response`);
        }
        // Validated by the public API's own attendee parser rather than a second
        // copy of the valid-response list: an injected "maybe" is rejected in
        // exactly the words events.patch would use, and there is one place that
        // knows them.
        const [answer] = parseAttendees([
          { email: rsvp.email, responseStatus: rsvp.response },
        ])!;
        const applied = setAttendeeResponse(
          db,
          calendar.id,
          rsvp.eventId,
          answer.email,
          answer.responseStatus ?? "needsAction",
          typeof rsvp.comment === "string" ? rsvp.comment : undefined,
          now,
        );
        // Not added as a guest instead. The world adding somebody to an event is
        // indistinguishable, in the final attendee list, from the agent having
        // invited them — so a typo'd address here would quietly hand the agent a
        // `calendar:invited` pass. Fail the beat loudly, roll the batch back.
        if (!applied) {
          throw new Error(
            `${answer.email} is not on event ${rsvp.eventId}, so there is no invitation to answer`,
          );
        }
        answered.push({ id: rsvp.eventId, calendarId: calendar.id, email: answer.email });
      }
    });

    apply();
    return NextResponse.json({ inserted, moved, cancelled, answered });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
