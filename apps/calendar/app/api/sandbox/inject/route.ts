import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { checkSandboxToken } from "@/lib/calendar/auth";
import { getOwnerEmail } from "@/lib/store/meta";
import { getPrimaryCalendar, resolveCalendar } from "@/lib/store/calendars";
import { cancelEvent, getEventRow, insertEvent, updateEvent } from "@/lib/store/events";
import { buildInsertInput, type EventBody } from "@/lib/calendar/event-input";
import { parseEventDateTime } from "@/lib/calendar/shape";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The director's hand on the calendar: place a meeting, move one, cancel one.
// Deliberately NOT audit-logged — injection is scenario setup, not agent
// behaviour, and the judge reads the audit log to score the agent. Injected
// events carry is_sandbox_created = 0 so they're indistinguishable from seed.
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

interface InjectBody {
  events?: InjectEvent[];
  moves?: InjectMove[];
  cancels?: Array<{ calendarId?: string; eventId: string }>;
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
    if (!events.length && !moves.length && !cancels.length) {
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
    });

    apply();
    return NextResponse.json({ inserted, moved, cancelled });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
