import { startNewSession } from "../audit";
import { applySchema, getDb } from "../db";
import { snapshotWorking } from "../reset";
import { countCalendars, insertCalendar } from "../store/calendars";
import { countEvents, insertEvent } from "../store/events";
import { setMeta } from "../store/meta";
import type { ParsedSeed, SeedResult } from "./types";

// Loading a cloned business into the calendar.
//
// Total, never additive: the previous world is deleted down to the meta row that
// says who the owner is, because a calendar carrying two companies' meetings is a
// world no episode described. Everything is written verbatim — the seed's own
// ids, absolute timestamps, attendee addresses and RSVPs — so the event the
// director later moves by id is the event the seed created, and the Priya on the
// 2pm invite is the Priya in the inbox.
//
// Snapshot handling mirrors the Gmail twin: with `promoteToSnapshot` the seeded
// state becomes what every later `reset` in the run returns to, which is what
// lets a cloned business survive an episode. Without it the pristine snapshot is
// left exactly as it was.

export function seedFromWire(seed: ParsedSeed): SeedResult {
  const db = getDb();
  // Idempotent, and it makes a working.db that was never `db:init`ed seedable.
  applySchema(db);

  const write = db.transaction(() => {
    db.prepare("DELETE FROM event_attendees").run();
    db.prepare("DELETE FROM events").run();
    db.prepare("DELETE FROM calendars").run();
    db.prepare("DELETE FROM meta").run();

    setMeta(db, "owner_email", seed.ownerEmail);
    setMeta(db, "owner_name", seed.ownerName);
    setMeta(db, "default_time_zone", seed.timezone);
    setMeta(db, "seeded_at", String(seed.nowMs));

    for (const calendar of seed.calendars) {
      insertCalendar(db, {
        id: calendar.id,
        summary: calendar.summary,
        description: calendar.description || null,
        timeZone: calendar.timezone,
        isPrimary: calendar.primary,
        // The wire carries no access role. The owner's own calendars are theirs;
        // anything else is a shared team calendar they can still write to —
        // freeBusyReader would hide its events from the agent entirely.
        accessRole:
          calendar.primary || calendar.ownerEmail.toLowerCase() === seed.ownerEmail.toLowerCase()
            ? "owner"
            : "writer",
      });
    }

    for (const event of seed.events) {
      insertEvent(db, {
        id: event.id,
        calendarId: event.calendarId,
        summary: event.summary,
        description: event.description || null,
        location: event.location || null,
        startMs: event.startMs,
        endMs: event.endMs,
        allDay: event.allDay,
        // An all-day event is a date, not a time, so it carries no zone.
        startTz: event.allDay ? null : event.timezone,
        endTz: event.allDay ? null : event.timezone,
        recurrence: event.recurrence.length ? event.recurrence : null,
        organizerEmail: event.organizerEmail,
        // Authored at the world's instant, not at wall-clock time: re-seeding the
        // same world twice has to produce the same calendar.
        createdMs: seed.nowMs,
        updatedMs: seed.nowMs,
        // Seeded history belongs to the world; only the agent's own writes carry
        // the sandbox-created flag the judge reads.
        isSandboxCreated: false,
        attendees: event.attendees.map((a) => ({
          email: a.email,
          displayName: a.displayName || null,
          responseStatus: a.responseStatus,
        })),
      });
    }
  });

  write();
  const counts = { calendars: countCalendars(db), events: countEvents(db) };

  // Closes and reopens the working handle, so nothing may hold `db` past here.
  if (seed.promoteToSnapshot) snapshotWorking();

  // A new world deserves a new audit session: the trail the judge reads must not
  // begin in the middle of the company that was here before.
  startNewSession(getDb(), `seeded ${seed.businessName}`, seed.nowMs);

  return { ok: true, counts };
}
