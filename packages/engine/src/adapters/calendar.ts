import {
  displayAddress,
  emailOf,
  type AgentTrace,
  type BeatBody,
  type CalendarDiff,
  type CalendarSnapshot,
  type EpisodeSpec,
  type InjectContext,
  type InjectedRef,
  type JudgeStep,
  type TwinAdapter,
  type TwinAuditRow,
  type TwinDiff,
  type TwinHealth,
  type TwinSnapshot,
} from "@sonata/core";
import { createTwinHttp, type TwinHttpOptions } from "../http";
import { projectTwinTrace } from "../project";
import {
  auditViaActivity,
  byKey,
  difference,
  healthViaApi,
  resetViaApi,
  seedViaApi,
} from "./shared";

// The calendar twin, behind @sonata/core's TwinAdapter.
//
// Capture is deliberately thin — times, attendees and status, nothing else —
// because that is the whole of what an agent can get wrong about a meeting, and
// because the same token discipline the Gmail snapshot follows applies here: an
// artifact carries two snapshots forever, and a description field would triple
// them for no signal. Untouched events are counted, never listed.

/** Events per snapshot, across every calendar. A workday touches a handful. */
const MAX_EVENTS = 250;

interface CalendarListEntry {
  id?: string;
  summary?: string;
  primary?: boolean;
}

interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface CalendarEventResource {
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

/** All-day events carry a `date`; timed ones a `dateTime`. Both are instants. */
export function whenOf(v: EventDateTime | undefined): string {
  return v?.dateTime ?? v?.date ?? "";
}

function statusOf(raw: string | undefined): CalendarSnapshot["events"][number]["status"] {
  return raw === "cancelled" || raw === "tentative" ? raw : "confirmed";
}

export interface CalendarAdapterOptions extends Omit<TwinHttpOptions, "baseUrl"> {
  baseUrl?: string;
}

export function createCalendarAdapter(opts: CalendarAdapterOptions = {}): TwinAdapter {
  const baseUrl = opts.baseUrl ?? process.env.CALENDAR_TWIN_URL ?? "http://localhost:3400";
  const http = createTwinHttp("calendar", { ...opts, baseUrl });
  const api = "/calendar/v3";

  return {
    name: "calendar",
    baseUrl,

    health(): Promise<TwinHealth> {
      return healthViaApi(http, "calendar");
    },

    async snapshot(): Promise<TwinSnapshot> {
      const list = await http.get<{ items?: CalendarListEntry[] }>(`${api}/users/me/calendarList`);
      const events: CalendarSnapshot["events"] = [];

      for (const cal of list.items ?? []) {
        if (!cal.id || events.length >= MAX_EVENTS) continue;
        const res = await http.get<{ items?: CalendarEventResource[] }>(
          `${api}/calendars/${encodeURIComponent(cal.id)}/events`,
          {
            // Expanded, so a recurring meeting the agent moved shows as the one
            // instance it moved rather than an unchanged master.
            singleEvents: true,
            orderBy: "startTime",
            // A cancelled event is the only trace a destructive action leaves;
            // hiding it would render as a meeting that simply vanished.
            showDeleted: true,
            maxResults: MAX_EVENTS - events.length,
          },
        );
        for (const e of res.items ?? []) {
          if (!e.id) continue;
          events.push({
            eventId: e.id,
            title: e.summary ?? "",
            startISO: whenOf(e.start),
            endISO: whenOf(e.end),
            organizer: e.organizer?.email ?? "",
            attendees: (e.attendees ?? []).map((a) => ({
              email: a.email ?? "",
              response: a.responseStatus ?? "needsAction",
            })),
            ...(e.location ? { location: e.location } : {}),
            status: statusOf(e.status),
          });
        }
      }

      return { twin: "calendar", capturedAt: Date.now(), events };
    },

    diff(before: TwinSnapshot, after: TwinSnapshot): TwinDiff {
      return diffCalendar(before as CalendarSnapshot, after as CalendarSnapshot);
    },

    renderDiff(diff: TwinDiff): string {
      return renderCalendarDiff(diff as CalendarDiff);
    },

    async inject(body: BeatBody, ctx: InjectContext): Promise<InjectedRef> {
      if (body.twin !== "calendar") {
        throw new Error(`calendar adapter cannot inject a ${body.twin} beat`);
      }

      // Like the other twins, the world writes through the sandbox route rather
      // than the public API: an invite the story sends is not an action the agent
      // took, and the audit log is how the engine tells those apart.
      if (body.kind === "invite") {
        const p = body.payload;
        const res = await http.post<{ inserted?: Array<{ id: string; calendarId: string }> }>(
          "/api/sandbox/inject",
          {
            events: [
              {
                summary: p.title,
                ...(p.description ? { description: p.description } : {}),
                ...(p.location ? { location: p.location } : {}),
                start: { dateTime: p.startISO },
                end: { dateTime: p.endISO },
                organizer: { email: emailOf(ctx.world, p.organizer) },
                attendees: p.attendees.map((a) => ({
                  email: emailOf(ctx.world, a),
                  displayName: displayAddress(ctx.world, a).split(" <")[0],
                  responseStatus: "needsAction",
                })),
              },
            ],
          },
        );
        const first = res.inserted?.[0];
        if (!first) throw new Error("calendar inject returned nothing");
        return { twin: "calendar", id: first.id, containerId: first.calendarId };
      }

      const target = ctx.resolve(body.payload.eventRef);
      if (!target) {
        throw new Error(`${body.kind} targets "${body.payload.eventRef}", which nothing created`);
      }
      const handle: InjectedRef = {
        twin: "calendar",
        id: target.id,
        ...(target.containerId ? { containerId: target.containerId } : {}),
      };

      if (body.kind === "move") {
        await http.post("/api/sandbox/inject", {
          moves: [
            {
              eventId: target.id,
              calendarId: target.containerId,
              start: { dateTime: body.payload.startISO },
              end: { dateTime: body.payload.endISO },
            },
          ],
        });
        return handle;
      }
      if (body.kind === "cancel") {
        await http.post("/api/sandbox/inject", {
          cancels: [{ eventId: target.id, calendarId: target.containerId }],
        });
        return handle;
      }

      // An RSVP is somebody else answering an invite — world, not agent — so it
      // would have to go through the same non-audited route as everything else
      // the world does. That route takes events, moves and cancels and nothing
      // else, and the public events.patch would write an audit row attributing
      // the coworker's answer to the agent, which is the one thing grading reads.
      // So this fails loudly on the beat rather than quietly on the score.
      throw new Error(
        `the calendar twin's POST /api/sandbox/inject handles events, moves and cancels but ` +
          `not rsvps, so ${emailOf(ctx.world, body.payload.who)} could not answer "` +
          `${body.payload.eventRef}" — drop the rsvp beat or add an rsvps branch to that route`,
      );
    },

    // Seeds the cast and the owner's primary calendar, no events — the same
    // deal the other two twins get. The twin checks every calendar owner against
    // `world.cast`, so a seed built from another world is a 400 here rather than
    // a calendar quietly holding different people from the inbox.
    seed(spec: EpisodeSpec): Promise<void> {
      return seedViaApi(http, "calendar", spec);
    },

    reset(): Promise<void> {
      return resetViaApi(http, "episode reset");
    },

    auditSince(sinceId: number): Promise<TwinAuditRow[]> {
      return auditViaActivity(http, "calendar", sinceId, { sinceId, limit: 1000 });
    },

    projectTrace(trace: AgentTrace): JudgeStep[] {
      return projectTwinTrace(trace, "calendar");
    },
  };
}

// ---------------------------------------------------------------------------
// Diff — pure. Keyed by eventId, which survives a move, a rename and a cancel.
// ---------------------------------------------------------------------------

const byTitle = byKey<{ title: string; eventId: string }>((e) => `${e.title} ${e.eventId}`);

export function diffCalendar(before: CalendarSnapshot, after: CalendarSnapshot): CalendarDiff {
  const beforeById = new Map(before.events.map((e) => [e.eventId, e]));

  const created: CalendarDiff["created"] = [];
  const cancelled: CalendarDiff["cancelled"] = [];
  const moved: CalendarDiff["moved"] = [];
  const attendeesChanged: CalendarDiff["attendeesChanged"] = [];
  const rsvpChanged: CalendarDiff["rsvpChanged"] = [];
  let unchangedCount = 0;

  for (const e of after.events) {
    const prev = beforeById.get(e.eventId);
    if (!prev) {
      // A brand-new event that arrives already cancelled is not a creation worth
      // reporting as one — but it is also not something the world does, so it
      // still counts as created rather than disappearing from the diff.
      created.push({
        eventId: e.eventId,
        title: e.title,
        startISO: e.startISO,
        attendees: e.attendees.map((a) => a.email).sort(),
      });
      continue;
    }

    let touched = false;
    if (prev.status !== "cancelled" && e.status === "cancelled") {
      cancelled.push({ eventId: e.eventId, title: e.title });
      touched = true;
    }
    if (prev.startISO !== e.startISO || prev.endISO !== e.endISO) {
      moved.push({ eventId: e.eventId, title: e.title, fromISO: prev.startISO, toISO: e.startISO });
      touched = true;
    }

    const beforeEmails = prev.attendees.map((a) => a.email);
    const afterEmails = e.attendees.map((a) => a.email);
    const addedAttendees = difference(afterEmails, beforeEmails);
    const removedAttendees = difference(beforeEmails, afterEmails);
    if (addedAttendees.length || removedAttendees.length) {
      attendeesChanged.push({
        eventId: e.eventId,
        title: e.title,
        added: addedAttendees,
        removed: removedAttendees,
      });
      touched = true;
    }

    const responses = new Map(prev.attendees.map((a) => [a.email, a.response]));
    for (const a of e.attendees) {
      const was = responses.get(a.email);
      if (was !== undefined && was !== a.response) {
        rsvpChanged.push({ eventId: e.eventId, who: a.email, from: was, to: a.response });
        touched = true;
      }
    }

    // Counted, never listed — the same discipline the mailbox diff follows. Most
    // of a week's calendar is untouched by any one day's work.
    if (!touched) unchangedCount++;
  }

  // An event gone from the capture entirely: the twin tombstones cancellations,
  // so this is a hard delete, and it is reported as a cancellation because that
  // is what it means to everyone who was invited.
  const afterIds = new Set(after.events.map((e) => e.eventId));
  for (const e of before.events) {
    if (!afterIds.has(e.eventId)) cancelled.push({ eventId: e.eventId, title: e.title });
  }

  return {
    twin: "calendar",
    created: created.sort(byTitle),
    cancelled: cancelled.sort(byTitle),
    moved: moved.sort(byTitle),
    attendeesChanged: attendeesChanged.sort(byTitle),
    rsvpChanged: rsvpChanged.sort(byKey((r) => `${r.eventId} ${r.who}`)),
    unchangedCount,
  };
}

export function renderCalendarDiff(diff: CalendarDiff): string {
  const lines: string[] = [];
  for (const e of diff.created) {
    lines.push(`+ scheduled "${e.title}" at ${e.startISO} with ${e.attendees.join(", ")}`);
  }
  for (const e of diff.moved) lines.push(`~ moved "${e.title}" ${e.fromISO} → ${e.toISO}`);
  for (const e of diff.attendeesChanged) {
    const bits: string[] = [];
    if (e.added.length) bits.push(`+${e.added.join(", ")}`);
    if (e.removed.length) bits.push(`-${e.removed.join(", ")}`);
    lines.push(`~ "${e.title}" attendees ${bits.join(" ")}`);
  }
  for (const r of diff.rsvpChanged) lines.push(`~ ${r.who} ${r.from} → ${r.to} on ${r.eventId}`);
  for (const e of diff.cancelled) lines.push(`- cancelled "${e.title}"`);
  lines.push(`${diff.unchangedCount} event(s) untouched`);
  return lines.join("\n");
}
