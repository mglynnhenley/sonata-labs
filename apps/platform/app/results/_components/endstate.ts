import type {
  AttioSnapshot,
  CalendarSnapshot,
  EpisodeJudgeReport,
  EpisodeRun,
  GmailSnapshot,
  GoogleAdsSnapshot,
  GoogleDocsSnapshot,
  LinkedInSnapshot,
  Person,
  SlackSnapshot,
  TickRecord,
  TwinName,
  TwinSnapshot,
} from "@sonata/core";
import { formatSimTime } from "../_lib/summary";

// WHERE THE DAY ENDED UP — the other half of the question a diff answers.
//
// Every surface on the run page is built from what MOVED: the replay is the
// agent's actions, the failure card is what went wrong in them, the diffs the
// judge reads are added/changed/removed. All of them are change-logs, and a
// change-log is silent about exactly the thing several criteria are about.
// "No customer is left without a response" is a claim about where things
// FINISHED. A thread the agent never opened leaves no mark in a diff — its
// absence is the finding, and the diff cannot carry it. Same on the diary: a
// diff shows one meeting moved; only the closing picture shows the afternoon it
// moved into now holds two.
//
// The artifact already has the picture — `snapshots[twin].after` — and nothing
// on the page reads it. This module does: it narrows each closing snapshot to
// counts a reader can scan and the handful of items that are still OPEN, which
// is all "where did it end up" ever means in practice.
//
// Two rules it keeps to, because this section is the one most able to invent a
// fact:
//
//   1. Every number is read off the closing snapshot's own list. The Gmail
//      snapshot carries a label-level unread count (15) and a thread list whose
//      unread threads number 10; both are true of different things, and a
//      section printing one under a heading about the other is a lie a reader
//      cannot catch. Threads throughout, said as threads.
//   2. It says what it left out. The diary holds every event the world was
//      seeded with — 250 on the run this was built against, two of them on the
//      day — so a count of "meetings" that quietly meant "meetings, ever" would
//      be worse than no count at all.

const OPEN_CAP = 5;
/** Second bucket per surface, so 15 unread threads cannot crowd out 8 unsent drafts. */
const SECOND_CAP = 2;

export const TWIN_WORD: Record<TwinName, string> = {
  gmail: "Email",
  slack: "Slack",
  calendar: "Calendar",
  attio: "CRM",
  "google-docs": "Docs",
  "google-ads": "Ads",
  linkedin: "LinkedIn",
};

/** One number about the state at close. */
export interface EndCount {
  label: string;
  value: number;
  /** Something is still open behind this number — the ones a reader stops at. */
  flag: boolean;
}

/** One thing the day ended still open. Never a change: a leftover. */
export interface OpenItem {
  key: string;
  /** The thing itself — a subject line, a message, a meeting. */
  what: string;
  /** Whose it is. Empty when the surface names nobody. */
  who: string;
  /** The company's own wall clock, dated when it is not the day that ran. */
  when: string;
  /** Why it counts as still open, in the words a person would use. */
  why: string;
}

export interface TwinEnd {
  twin: TwinName;
  counts: EndCount[];
  open: OpenItem[];
  /** Open items past the cap, so a short list never reads as a short problem. */
  more: number;
  /**
   * What is true when nothing is open. Printed instead of an empty list, and
   * empty when the surface cannot even say that — `slackEnd` with no owner it
   * recognises has an empty list because it refused to judge, not because the
   * day was tidy.
   */
  settled: string;
  /** What this picture leaves out. Null when it is the whole surface. */
  scope: string | null;
}

/**
 * What the assessor was shown of the closing state.
 *
 * Deliberately its own note and not part of `judgeSight`: the judge's
 * `coverage.fraction` is how much of the DAY fitted, and end state is dropped by
 * relevance rather than by size (`JudgeCoverage.finalState` says so itself). One
 * folded into the other would report every ordinary run as part-read.
 */
export type AssessorSight =
  /** No coverage block at all — a report filed before any of this was counted. */
  | { kind: "unrecorded" }
  /** Coverage counted, end state absent: it was judged off the changes alone. */
  | { kind: "diff-only" }
  | { kind: "partial"; shown: number; total: number };

export interface EndOfDayReport {
  /** The company's own clock when the last check-in ended — when this was taken. */
  closedAt: string;
  twins: TwinEnd[];
  /** Surfaces the run used whose closing picture never landed, in our own words. */
  unseen: Array<{ twin: TwinName; why: string }>;
  /** What the assessor saw of this. Null when it read all of it. */
  sight: AssessorSight | null;
}

/** Nothing to draw: no closing picture landed and nothing to own up to either. */
export function hasEndState(report: EndOfDayReport): boolean {
  return report.twins.length > 0 || report.unseen.length > 0;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** A count's own label, agreeing with it: "1 draft left unsent", "8 drafts left unsent". */
function agree(n: number, one: string, tail = ""): string {
  return `${one}${n === 1 ? "" : "s"}${tail}`;
}

/** The day the run played, as its own calendar date — the diary's window. */
function localDay(ms: number, offsetMinutes: number): string {
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

interface Cast {
  /** The mailbox owner — the person the agent is standing in for. Null if uncast. */
  self: Person | null;
  byEmail: Map<string, string>;
  bySlackId: Map<string, string>;
}

function castOf(people: readonly Person[]): Cast {
  const byEmail = new Map<string, string>();
  const bySlackId = new Map<string, string>();
  for (const p of people) {
    if (p.email) byEmail.set(p.email.toLowerCase(), p.name);
    if (p.slackUserId) bySlackId.set(p.slackUserId, p.name);
  }
  return { self: people.find((p) => p.relationship === "self") ?? null, byEmail, bySlackId };
}

/** `"Arun Patel <arun@…>"` → the cast's name for that address, or what it says. */
function senderName(from: string, cast: Cast): string {
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(from);
  const email = (m?.[2] ?? from).trim().toLowerCase();
  return cast.byEmail.get(email) ?? m?.[1]?.trim() ?? from.trim();
}

function addressName(email: string, cast: Cast): string {
  return cast.byEmail.get(email.trim().toLowerCase()) ?? email.trim();
}

interface Ctx {
  cast: Cast;
  offsetMinutes: number;
  /** The date the run played on, so a stamp from any other day carries its date. */
  runDay: string;
  /** Midnight either side of that date, absolute. The diary's window. */
  dayStartMs: number;
  dayEndMs: number;
}

/**
 * A moment on the company's wall clock — "12:00", or "5 Aug 16:01" when it is
 * not the day that ran. A bare time on a thread from yesterday reads as today's,
 * and "waiting since 09:45" is the whole point of printing it.
 */
function stamp(ms: number, ctx: Ctx): string {
  // A timestamp off disk is a claim, not a fact, and `new Date(NaN)` throws on
  // the way to a string. A row with no clock still says what is open.
  if (!Number.isFinite(ms)) return "";
  const time = formatSimTime(new Date(ms).toISOString(), ctx.offsetMinutes);
  if (localDay(ms, ctx.offsetMinutes) === ctx.runDay) return time;
  const shifted = new Date(ms + ctx.offsetMinutes * 60_000);
  const date = shifted.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return `${date} ${time}`;
}

/**
 * 0 for the day that ran, 1 for anything the world was seeded with before it —
 * and for a stamp off disk that is not a date at all, which sorts last rather
 * than throwing on its way to one.
 */
function rank(ms: number, ctx: Ctx): number {
  if (!Number.isFinite(ms)) return 1;
  return localDay(ms, ctx.offsetMinutes) === ctx.runDay ? 0 : 1;
}

function span(startISO: string, endISO: string, ctx: Ctx): string {
  const start = Date.parse(startISO);
  const end = Date.parse(endISO);
  if (!Number.isFinite(start)) return "";
  const from = stamp(start, ctx);
  return Number.isFinite(end)
    ? `${from}–${formatSimTime(new Date(end).toISOString(), ctx.offsetMinutes)}`
    : from;
}

// ---------------------------------------------------------------------------
// Per twin
// ---------------------------------------------------------------------------

/**
 * The mailbox at close.
 *
 * Unread is counted over every thread rather than over the inbox label, because
 * a thread the agent archived unread is still unread — and one number for one
 * word is the rule this file keeps.
 */
function gmailEnd(after: GmailSnapshot, ctx: Ctx): TwinEnd {
  const inbox = after.threads.filter((t) => t.labels.includes("INBOX"));
  // This day's mail first, longest-waiting inside it. The seeded mailbox carries
  // threads that were already unread before the agent arrived, and a plain
  // oldest-first list is all of those and none of the day's own — which is the
  // one thing a reader of a run is asking about.
  const unread = after.threads
    .filter((t) => t.unread)
    .sort((a, b) => rank(a.date, ctx) - rank(b.date, ctx) || a.date - b.date);
  const drafts = after.drafts;

  const open: OpenItem[] = [
    ...unread.slice(0, OPEN_CAP).map((t) => ({
      key: `unread-${t.threadId}`,
      what: t.subject || "(no subject)",
      who: senderName(t.from, ctx.cast),
      when: stamp(t.date, ctx),
      // A thread carrying SENT was answered at some point and has gone unread
      // since — a different failure from one nobody ever opened, and the two
      // must not print as the same sentence.
      why: t.labels.includes("SENT") ? "answered earlier, unread since" : "never opened",
    })),
    ...drafts.slice(0, SECOND_CAP).map((d) => ({
      key: `draft-${d.draftId}`,
      what: d.subject || excerpt(d.excerpt, 60),
      who: d.to.map((to) => addressName(to, ctx.cast)).join(", "),
      when: "",
      why: "written, never sent",
    })),
  ];

  return {
    twin: "gmail",
    counts: [
      { label: agree(inbox.length, "thread", " in the inbox"), value: inbox.length, flag: false },
      { label: "still unread", value: unread.length, flag: unread.length > 0 },
      {
        label: agree(drafts.length, "draft", " left unsent"),
        value: drafts.length,
        flag: drafts.length > 0,
      },
    ],
    open,
    more: Math.max(0, unread.length - OPEN_CAP) + Math.max(0, drafts.length - SECOND_CAP),
    settled: "Nothing left unread, and no draft left unsent.",
    scope:
      after.threads.length > inbox.length
        ? `The mailbox holds ${after.threads.length} ${agree(after.threads.length, "thread")} at ` +
          `close; ${inbox.length} of them are in the inbox.`
        : null,
  };
}

/**
 * The workspace at close: who had the last word, and where nobody answered it.
 *
 * The message list is capped and recent-first by the adapter, so the last message
 * in a channel is reliable and a total off it is not — the counts come from the
 * channel rows, which are complete.
 */
function slackEnd(after: SlackSnapshot, ctx: Ctx): TwinEnd {
  const last = new Map<string, SlackSnapshot["messages"][number]>();
  for (const m of after.messages) {
    const held = last.get(m.channelId);
    if (!held || Number(m.ts) > Number(held.ts)) last.set(m.channelId, m);
  }

  // Only claimable with a mailbox owner who actually posts in THIS workspace.
  // A run whose clone was seeded from somewhere other than its own scenario
  // carries ids the cast has never heard of — and then the agent's own last
  // message is a stranger's, and reads as a person it left hanging.
  const known = after.messages.some((m) => ctx.cast.bySlackId.has(m.user));
  const self = known ? ctx.cast.self : null;

  const messages = after.channels.reduce((n, c) => n + c.messageCount, 0);
  const hanging = self
    ? [...last.values()].filter((m) => m.user !== self.slackUserId && m.replyCount === 0)
    : [];
  // This day's messages first, as in the mailbox: a channel that has been quiet
  // since last week is state, but it is not what this run left behind.
  hanging.sort(
    (a, b) =>
      rank(Number(a.ts) * 1000, ctx) - rank(Number(b.ts) * 1000, ctx) || Number(a.ts) - Number(b.ts),
  );

  const counts: EndCount[] = [
    { label: agree(after.channels.length, "channel"), value: after.channels.length, flag: false },
    { label: agree(messages, "message"), value: messages, flag: false },
  ];
  if (self) {
    counts.push({ label: "left without an answer", value: hanging.length, flag: hanging.length > 0 });
  }

  return {
    twin: "slack",
    counts,
    open: hanging.slice(0, OPEN_CAP).map((m) => ({
      key: `hanging-${m.channelId}-${m.ts}`,
      what: excerpt(m.text, 130),
      who: `${ctx.cast.bySlackId.get(m.user) ?? m.user} in #${m.channelName}`,
      when: stamp(Number(m.ts) * 1000, ctx),
      why: "had the last word; nothing answered it",
    })),
    more: Math.max(0, hanging.length - OPEN_CAP),
    // Empty when there is no owner to say it of: "the agent had the last word"
    // is a claim about which of these people the agent was.
    settled: self ? "Every channel's last message is the agent's own, or has a reply under it." : "",
    scope: self
      ? null
      : "Nobody who posted in this workspace is in the cast this run was written from, so who was left waiting cannot be read off it.",
  };
}

/**
 * The diary at close, windowed to the day that ran.
 *
 * The world seeds months of events and the agent could not touch most of them; a
 * "meetings" count that meant "meetings, ever" would say nothing about this day.
 * Invitations are the one thing carried past the window — an unanswered invite
 * for tomorrow is still unanswered tonight — and never before it, because an
 * invitation to a meeting that has already happened is not a loose end.
 */
function calendarEnd(after: CalendarSnapshot, ctx: Ctx): TwinEnd {
  const live = after.events.filter((e) => e.status !== "cancelled");
  const onDay = live
    .filter((e) => {
      const start = Date.parse(e.startISO);
      const end = Date.parse(e.endISO);
      if (!Number.isFinite(start)) return false;
      return start < ctx.dayEndMs && (Number.isFinite(end) ? end : start) > ctx.dayStartMs;
    })
    .sort((a, b) => Date.parse(a.startISO) - Date.parse(b.startISO));

  // Double-booked: each event that starts before the latest end seen so far.
  const clashes: Array<{ event: CalendarSnapshot["events"][number]; with: string }> = [];
  let heldTitle = "";
  let heldEnd = -Infinity;
  for (const e of onDay) {
    const start = Date.parse(e.startISO);
    const end = Date.parse(e.endISO);
    if (start < heldEnd) clashes.push({ event: e, with: heldTitle });
    if (end > heldEnd) {
      heldEnd = end;
      heldTitle = e.title;
    }
  }

  const self = ctx.cast.self;
  const invites = self
    ? live
        .filter(
          (e) =>
            Date.parse(e.startISO) >= ctx.dayStartMs &&
            e.organizer.toLowerCase() !== self.email.toLowerCase() &&
            e.attendees.some(
              (a) => a.email.toLowerCase() === self.email.toLowerCase() && a.response === "needsAction",
            ),
        )
        .sort((a, b) => Date.parse(a.startISO) - Date.parse(b.startISO))
    : [];

  const counts: EndCount[] = [
    { label: agree(onDay.length, "meeting", " on the day"), value: onDay.length, flag: false },
    { label: "double-booked", value: clashes.length, flag: clashes.length > 0 },
  ];
  if (self) {
    counts.push({
      label: agree(invites.length, "invitation", " unanswered"),
      value: invites.length,
      flag: invites.length > 0,
    });
  }

  return {
    twin: "calendar",
    counts,
    open: [
      ...clashes.slice(0, OPEN_CAP).map((c) => ({
        key: `clash-${c.event.eventId}`,
        what: c.event.title,
        who: "",
        when: span(c.event.startISO, c.event.endISO, ctx),
        why: `runs over ${c.with}`,
      })),
      ...invites.slice(0, SECOND_CAP).map((e) => ({
        key: `invite-${e.eventId}`,
        what: e.title,
        who: addressName(e.organizer, ctx.cast),
        when: span(e.startISO, e.endISO, ctx),
        why: "invitation never answered",
      })),
    ],
    more: Math.max(0, clashes.length - OPEN_CAP) + Math.max(0, invites.length - SECOND_CAP),
    // The invitation half is only claimable with an owner to have answered them.
    settled: self
      ? "Nothing overlaps, and every invitation has an answer."
      : "Nothing on this day overlaps.",
    scope:
      live.length > onDay.length
        ? `The diary holds ${live.length} ${agree(live.length, "event")}; the ${onDay.length} on ` +
          `this day ${onDay.length === 1 ? "is" : "are"} what is counted here, plus invitations ` +
          `from this day on.`
        : null,
  };
}

/**
 * The CRM at close. The loose end here is a follow-up nobody closed — a task is
 * the one thing on this surface that is explicitly still open, and the snapshot
 * carries its state, its owner and its deadline.
 *
 * Records are counted and never listed as open: a CRM row is not outstanding
 * work, it is the file the work is about, and calling one "open" would invent a
 * finding out of an account simply existing.
 */
function attioEnd(after: AttioSnapshot, ctx: Ctx): TwinEnd {
  const open = after.tasks.filter((t) => !t.isCompleted);
  // Soonest deadline first, undated last — an undated follow-up sorts to the
  // bottom rather than to 1970, which is where `Date.parse` would put it.
  const due = (t: AttioSnapshot["tasks"][number]): number =>
    t.deadlineISO ? Date.parse(t.deadlineISO) : Number.POSITIVE_INFINITY;
  const sorted = [...open].sort((a, b) => due(a) - due(b));

  return {
    twin: "attio",
    counts: [
      { label: agree(after.records.length, "record"), value: after.records.length, flag: false },
      { label: agree(open.length, "follow-up", " still open"), value: open.length, flag: open.length > 0 },
    ],
    open: sorted.slice(0, OPEN_CAP).map((t) => ({
      key: `task-${t.taskId}`,
      what: excerpt(t.content, 130),
      who: t.assignees.map((a) => addressName(a, ctx.cast)).join(", "),
      when: t.deadlineISO ? stamp(Date.parse(t.deadlineISO), ctx) : "",
      // A follow-up nobody dated is a different kind of loose end from one that
      // is late, and the two must not print as the same sentence.
      why: t.deadlineISO ? "follow-up nobody closed" : "follow-up with no deadline on it",
    })),
    more: Math.max(0, open.length - OPEN_CAP),
    settled: "Every follow-up in the CRM is closed.",
    scope: null,
  };
}

/**
 * The workspace at close. A document that exists and says nothing is the loose
 * end: `create_document` makes an empty one and the body arrives afterwards, so
 * an empty document at the end of the day is work that was started and dropped.
 */
function googleDocsEnd(after: GoogleDocsSnapshot, ctx: Ctx): TwinEnd {
  const empty = after.documents.filter((d) => d.characterCount === 0);
  return {
    twin: "google-docs",
    counts: [
      { label: agree(after.documents.length, "document"), value: after.documents.length, flag: false },
      { label: agree(empty.length, "document", " left empty"), value: empty.length, flag: empty.length > 0 },
    ],
    open: empty.slice(0, OPEN_CAP).map((d) => ({
      key: `empty-${d.documentId}`,
      what: d.title || "(untitled)",
      who: addressName(d.ownerEmail, ctx.cast),
      when: "",
      why: "started, never written",
    })),
    more: Math.max(0, empty.length - OPEN_CAP),
    settled: "Every document has something in it.",
    scope: null,
  };
}

/**
 * The advertiser account at close. A campaign left PAUSED is the thing a reader
 * stops at — an agent that paused something at 10:00 and never put it back has
 * left the money switched off — and a campaign with no budget attached cannot
 * run at all.
 */
function googleAdsEnd(after: GoogleAdsSnapshot): TwinEnd {
  const paused = after.campaigns.filter((c) => c.status === "PAUSED");
  const unfunded = after.campaigns.filter((c) => c.status !== "REMOVED" && !c.budgetId);

  return {
    twin: "google-ads",
    counts: [
      { label: agree(after.campaigns.length, "campaign"), value: after.campaigns.length, flag: false },
      { label: "left paused", value: paused.length, flag: paused.length > 0 },
    ],
    open: [
      ...paused.slice(0, OPEN_CAP).map((c) => ({
        key: `paused-${c.campaignId}`,
        what: c.name,
        who: "",
        when: "",
        why: "paused when the day ended",
      })),
      ...unfunded.slice(0, SECOND_CAP).map((c) => ({
        key: `unfunded-${c.campaignId}`,
        what: c.name,
        who: "",
        when: "",
        why: "no budget attached, so it cannot spend",
      })),
    ],
    more: Math.max(0, paused.length - OPEN_CAP) + Math.max(0, unfunded.length - SECOND_CAP),
    settled: "No campaign was left paused, and every one of them has a budget.",
    // Spend is in the snapshot and deliberately not counted here: the capture
    // covers a reporting window several days wide, so a figure printed under a
    // heading about one day would be the kind of lie a reader cannot catch.
    scope: "What these campaigns spent is not counted here: the capture covers a window several days wide, not this day.",
  };
}

/**
 * The feed at close. A post still in DRAFT is the loose end — written and never
 * published is the same shape of failure as a mail draft never sent.
 *
 * Comments are counted, never listed as open, and the scope line says why: the
 * capture names each comment's post but never its parent, so "nobody answered
 * this customer" is not a claim this snapshot can support.
 */
function linkedInEnd(after: LinkedInSnapshot): TwinEnd {
  const drafts = after.posts.filter((p) => p.lifecycleState === "DRAFT");
  return {
    twin: "linkedin",
    counts: [
      { label: agree(after.posts.length, "post"), value: after.posts.length, flag: false },
      { label: agree(after.comments.length, "comment"), value: after.comments.length, flag: false },
      { label: agree(drafts.length, "post", " left in draft"), value: drafts.length, flag: drafts.length > 0 },
    ],
    open: drafts.slice(0, OPEN_CAP).map((p) => ({
      key: `draft-${p.postUrn}`,
      what: excerpt(p.commentary, 130) || "(no text)",
      // The URN is the only name this surface gives an author, and it is not one
      // the cast can be matched against.
      who: p.author,
      when: "",
      why: "written, never published",
    })),
    more: Math.max(0, drafts.length - OPEN_CAP),
    settled: "Nothing is left sitting in draft.",
    scope:
      "Whether anyone answered a comment cannot be read off this: the capture names each " +
      "comment's post, never the comment it replies to.",
  };
}

// ---------------------------------------------------------------------------
// What the assessor was shown of it
// ---------------------------------------------------------------------------

function assessorSight(judge: EpisodeJudgeReport | null): AssessorSight | null {
  if (!judge) return null;
  const coverage = judge.coverage;
  if (!coverage) return { kind: "unrecorded" };
  const slice = coverage.finalState;
  // Counted, and the end state was not among what was counted: this verdict was
  // formed on the changes alone. Stated, not inferred — the field is absent
  // exactly on reports written before the closing state reached the judge.
  if (!slice) return { kind: "diff-only" };
  if (!Number.isFinite(slice.shown) || !Number.isFinite(slice.total) || slice.total <= 0) {
    return { kind: "unrecorded" };
  }
  if (slice.shown >= slice.total) return null;
  return { kind: "partial", shown: Math.floor(slice.shown), total: Math.floor(slice.total) };
}

// ---------------------------------------------------------------------------

/** What this module reads off a run. Structural, so a `SavedRun` fits as-is. */
export interface EndStateInput {
  snapshots: EpisodeRun["snapshots"];
  ticks: readonly TickRecord[];
  /** The run's cast, for names and for which of them the agent stood in for. */
  cast: readonly Person[];
  /** Per twin, what the run saved — `RunEvidence.twins` fits this. */
  evidence: ReadonlyArray<{ twin: TwinName; after: boolean; note?: string }>;
  offsetMinutes: number;
  judge: EpisodeJudgeReport | null;
}

const TWIN_ORDER: readonly TwinName[] = [
  "gmail",
  "slack",
  "calendar",
  "attio",
  "google-docs",
  "google-ads",
  "linkedin",
];

function endOf(after: TwinSnapshot, ctx: Ctx): TwinEnd {
  switch (after.twin) {
    case "gmail":
      return gmailEnd(after, ctx);
    case "slack":
      return slackEnd(after, ctx);
    case "calendar":
      return calendarEnd(after, ctx);
    case "attio":
      return attioEnd(after, ctx);
    case "google-docs":
      return googleDocsEnd(after, ctx);
    case "google-ads":
      return googleAdsEnd(after);
    case "linkedin":
      return linkedInEnd(after);
  }
}

/**
 * Where each surface stood when the day stopped, built server-side so the client
 * is handed counts and prose rather than a quarter-megabyte of snapshot.
 */
export function endOfDay(input: EndStateInput): EndOfDayReport {
  const first = input.ticks[0]?.simTimeISO;
  const lastTick = input.ticks[input.ticks.length - 1]?.simTimeISO;
  // A day that never ran did not end anywhere. Runs that failed before their
  // first tick have no snapshots either, and owning up to an uncaptured close
  // on a day that never opened is noise on top of a page that already says the
  // run never executed.
  const startMs = first ? Date.parse(first) : NaN;
  if (!Number.isFinite(startMs)) return { closedAt: "", twins: [], unseen: [], sight: null };
  const runDay = localDay(startMs, input.offsetMinutes);
  // Midnight either side of the run's own date, as absolute instants: the diary
  // is UTC and the day is the company's, and an event at 23:30 local belongs to
  // the day the agent worked, not to the next one.
  const dayStartMs = Date.parse(`${runDay}T00:00:00Z`) - input.offsetMinutes * 60_000;

  const ctx: Ctx = {
    cast: castOf(input.cast),
    offsetMinutes: input.offsetMinutes,
    runDay,
    dayStartMs,
    dayEndMs: dayStartMs + 24 * 60 * 60_000,
  };

  const twins: TwinEnd[] = [];
  const unseen: EndOfDayReport["unseen"] = [];
  for (const twin of TWIN_ORDER) {
    const after = input.snapshots[twin]?.after;
    if (after) {
      twins.push(endOf(after, ctx));
      continue;
    }
    // A surface the run attached and never photographed at the end. Silence here
    // would render as a surface with nothing left open on it, which is the
    // flattering reading and the wrong one.
    const row = input.evidence.find((e) => e.twin === twin);
    if (row && !row.after) {
      unseen.push({
        twin,
        why: row.note ?? `no closing snapshot of ${twin} came back`,
      });
    }
  }

  return {
    closedAt: lastTick ? formatSimTime(lastTick, input.offsetMinutes) : "",
    twins,
    unseen,
    sight: assessorSight(input.judge),
  };
}

// ---------------------------------------------------------------------------
// The same account, for the document that leaves the building
// ---------------------------------------------------------------------------

function countLine(twin: TwinEnd): string {
  return twin.counts.map((c) => `${c.value} ${c.label}`).join(", ");
}

// The sentence that keeps the two questions apart. Twice, because the page and
// the document speak differently — "the agent" here, "the coworker" there, the
// same split `harnessMarkdown` makes — and kept side by side so the two cannot
// drift into saying different things.

/** For the run page, where every other section is the agent's actions. */
export const END_STATE_LEAD =
  "Every other section on this page is what the agent did. This is where each surface stood " +
  "when the day stopped — including everything it never touched, which no record of changes " +
  "can show.";

/** For the document that leaves the building. */
const END_STATE_LEAD_DOC =
  "The sections above are what the coworker did. This is where each system stood when the day " +
  "stopped — including everything it never touched, which no account of what changed can show.";

export function endStateMarkdown(report: EndOfDayReport): string {
  const out: string[] = [];
  const p = (line = "") => out.push(line);

  p(`## Where the day ended up`);
  p();
  p(
    report.closedAt
      ? `${END_STATE_LEAD_DOC} It stopped at ${report.closedAt}.`
      : END_STATE_LEAD_DOC,
  );

  for (const twin of report.twins) {
    p();
    p(`**${TWIN_WORD[twin.twin]}** — ${countLine(twin)}.`);
    if (twin.open.length === 0) {
      if (twin.settled) {
        p();
        p(twin.settled);
      }
    } else {
      p();
      for (const item of twin.open) {
        const head = [item.when, item.who].filter(Boolean).join(", ");
        p(`- ${head ? `**${head}** — ` : ""}${item.what} _(${item.why})_`);
      }
      if (twin.more > 0) {
        p();
        p(`_And ${twin.more} more like ${twin.more === 1 ? "it" : "them"}._`);
      }
    }
    if (twin.scope) {
      p();
      p(`_${twin.scope}_`);
    }
  }

  if (report.unseen.length > 0) {
    p();
    for (const row of report.unseen) {
      p(`- **${TWIN_WORD[row.twin]}** — where this ended up is not in the file: ${row.why}.`);
    }
    p();
    p(
      `That is ours, not the coworker's. A surface with nothing left open reads as a clean one, ` +
        `and ${report.unseen.length === 1 ? "that one is" : "those are"} not that.`,
    );
  }

  if (report.sight) {
    p();
    p(sightSentence(report.sight));
  }

  return out.join("\n");
}

/** The coverage disclosure, one sentence, said the same way on the page and in the document. */
export function sightSentence(sight: AssessorSight): string {
  if (sight.kind === "unrecorded") {
    return "How much of this closing state the assessor was shown was not recorded for this run, so its verdict cannot be taken as a reading of all of it.";
  }
  if (sight.kind === "diff-only") {
    return "The assessor was shown what changed and not where things ended up, so nothing above is evidence it read. It is here for you.";
  }
  return (
    `The assessor was shown ${sight.shown} of the ${sight.total} things the systems ended the day ` +
    `holding — narrowed to this day rather than sampled, so what it did not see is what this day ` +
    `was not about.`
  );
}
