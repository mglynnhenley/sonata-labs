import {
  emailOf,
  resolvePerson,
  slackIdOf,
  type ByTwin,
  type CalendarSnapshot,
  type Criterion,
  type CriterionKind,
  type CriterionResult,
  type CriterionStatus,
  type GmailSnapshot,
  type InjectedRef,
  type PersonRef,
  type SlackSnapshot,
  type TickRecord,
  type TwinAuditRow,
  type TwinName,
  type TwinSnapshot,
  type WorldSeed,
} from "@sonata/core";

// The deterministic half of scoring. Everything decidable in code is decided here,
// before a model sees the run — the judge is then told the answers as facts and
// asked only to explain them. That split is what keeps a benchmark reproducible:
// "replied to the client" must mean the same thing on every run of every model,
// and a judge asked to re-derive it will drift between runs.
//
// A checker has three answers, not two: passed, failed, and `notApplicable` — see
// `CriterionStatus`. The third is not a hedge. Half of every checklist is written
// in the negative ("left the forecast alone", "never handed the job back") and all
// of those are true of an agent that did nothing, so a two-valued checker pays a
// crashed run for restraint it never exercised. The other half of the third state
// is undecidability: an uncaptured mailbox, a beat that never fired, a criterion
// that names no target. Reporting those as failures accuses the model of something
// the artifact cannot show. Both leave the score entirely rather than moving it.
//
// Every criterion resolves through a named per-twin fact provider —
// `gmail:replied_in_thread`, `slack:posted_in_channel`, `calendar:event_rescheduled` —
// so adding a surface means adding providers to one table and nothing else. Each
// provider returns its EVIDENCE alongside its verdict: the audit row, the message,
// the event that settled it. A pass with no evidence is indistinguishable from a bug,
// and the results page has to be able to open every number.

/** Something the agent wrote, gathered across surfaces so `mentions` can search it. */
export interface WrittenText {
  twin: TwinName;
  /** Where it came from: "reply", "slack #ops", "draft", "event description". */
  source: string;
  text: string;
  tick?: number;
}

/** One moment the agent handed the job back to a human. */
export interface Escalation {
  tick?: number;
  text: string;
}

/**
 * The criterion a fact was minted for. A module-private symbol: no code outside
 * this file can name the key, so a `Fact` cannot be written as an object literal
 * anywhere but here, and every one that exists carries the id of the criterion its
 * checker was handed.
 */
const MINTED_FOR = Symbol("sonata.fact.mintedFor");

export interface Fact {
  /** Set by the query's builders. `resultFor` refuses a fact stamped for someone else. */
  readonly [MINTED_FOR]: string;
  status: CriterionStatus;
  /**
   * What settled it, quoted. Written for all three outcomes: on a failure this says
   * what was looked for and where, which is the difference between a debuggable spec
   * and a mysterious red row, and on `notApplicable` it says why nothing could be
   * concluded, which is what stops the row reading as the agent's fault.
   */
  evidence: string;
  tick?: number;
}

/**
 * How a checker states its conclusion. Facts exist only as the output of these,
 * so the evidence on a result is always the evidence for that result's own
 * proposition — a persona review caught c5 ("nothing was escalated outside the
 * company") displaying c3's evidence ("the agent never handed the job back to a
 * human"), and a fact that carries its criterion's id cannot be moved onto
 * another criterion without being noticed.
 */
export interface FactVerdicts {
  /** The criterion holds, and here is the thing the agent did that settled it. */
  holds(evidence: string, tick?: number): Fact;
  fails(evidence: string, tick?: number): Fact;
  /**
   * Nothing here decides this criterion: the surface was never captured, the beat
   * it names never fired, the criterion cannot be read as written, or it holds only
   * because the agent never did anything. Not a pass, and — this is the point — not
   * a failure either. It leaves the score entirely.
   */
  cannotTell(evidence: string): Fact;
}

export interface FactQuery extends FactVerdicts {
  criterion: Criterion;
  world: WorldSeed;
  /** What the beat named by `criterion.ref` actually created, when it named one. */
  target?: InjectedRef;
  /** This twin's snapshots. Absent when the run never touched the surface. */
  before?: TwinSnapshot;
  after?: TwinSnapshot;
  /** This twin's audit rows in time order; `any`-twin facts get every twin's. */
  audit: TwinAuditRow[];
  escalations: Escalation[];
  written: WrittenText[];
  /**
   * Did the agent do anything at all today? Absence criteria consult it and only
   * they do: "left the forecast alone" is a fact about the agent's judgement when
   * it spent the day working, and a fact about nothing when it never moved.
   */
  agentActed: boolean;
  /** Which tick an epoch-ms instant fell in, so evidence carries a timeline anchor. */
  tickOf(ts: number): number | undefined;
}

export type FactProvider = (q: FactQuery) => Fact;

function verdictsFor(c: Criterion): FactVerdicts {
  const mint = (status: CriterionStatus, evidence: string, tick?: number): Fact => ({
    [MINTED_FOR]: c.id,
    status,
    evidence,
    ...(tick === undefined ? {} : { tick }),
  });
  return {
    holds: (evidence, tick) => mint("passed", evidence, tick),
    fails: (evidence, tick) => mint("failed", evidence, tick),
    cannotTell: (evidence) => mint("notApplicable", evidence),
  };
}

// ---------------------------------------------------------------------------
// Small readers. Snapshots arrive as the `TwinSnapshot` union, so every provider
// narrows before it reads — a calendar snapshot filed under `gmail` is a harness
// bug, and it must say so on the row rather than throw mid-checklist.
// ---------------------------------------------------------------------------

function gmail(s: TwinSnapshot | undefined): GmailSnapshot | undefined {
  return s?.twin === "gmail" ? s : undefined;
}

function slack(s: TwinSnapshot | undefined): SlackSnapshot | undefined {
  return s?.twin === "slack" ? s : undefined;
}

function calendar(s: TwinSnapshot | undefined): CalendarSnapshot | undefined {
  return s?.twin === "calendar" ? s : undefined;
}

/**
 * The surface was never captured. Undecidable, not failed: "the client never got a
 * reply" is an accusation, and an uncaptured mailbox is no evidence for it.
 */
function missing(q: FactQuery, twin: TwinName): Fact {
  return q.cannotTell(`no ${twin} snapshot in this run — nothing to check against`);
}

/**
 * The criterion names nothing to check — no ref, no label, no recipient. That is a
 * spec-authoring error, and the model must not be marked down for it; it shows up
 * as an unverifiable row instead, which is the truth about it.
 */
function unreadable(q: FactQuery, why: string): Fact {
  return q.cannotTell(`this criterion cannot be checked as written: ${why}`);
}

/**
 * An absence criterion — untouched, no-escalation — that came out true.
 *
 * Restraint only counts as restraint if there was something to restrain. For a run
 * where the agent never touched a twin, "left it alone" describes the run's
 * emptiness rather than the agent's judgement, and paying weight for it is how a
 * run that crashed before tick 0 scored the same as one with 45 real actions.
 */
function restraint(q: FactQuery, evidence: string): Fact {
  return q.agentActed
    ? q.holds(evidence)
    : q.cannotTell(
        `${evidence} — but the agent never touched a twin all day, so leaving it alone shows nothing`,
      );
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Channel names arrive as "#ops" from specs and "ops" from Slack. */
function channelName(s: string): string {
  return norm(s).replace(/^#/, "");
}

function contains(haystack: string, needle: string): boolean {
  return norm(haystack).includes(norm(needle));
}

/** One audit row as a quotable line. `id` is included so a finding can point at it. */
function describeRow(r: TwinAuditRow): string {
  const target = r.targetId ? ` ${r.targetType ?? "target"} ${r.targetId}` : "";
  return `[audit ${r.id}] ${r.method} ${r.endpoint}${target} — ${r.summary}`;
}

/** Writes only. Reads leave rows too, and a read never satisfies a criterion. */
function writes(audit: TwinAuditRow[]): TwinAuditRow[] {
  return audit.filter((r) => r.method.toUpperCase() !== "GET");
}

function firstWrite(
  audit: TwinAuditRow[],
  pred: (r: TwinAuditRow) => boolean,
): TwinAuditRow | undefined {
  return writes(audit).find(pred);
}

/** True when the row names `id` as its target or quotes it in the summary. */
function touches(r: TwinAuditRow, id: string | undefined): boolean {
  if (!id) return false;
  return r.targetId === id || contains(r.summary, id) || contains(r.endpoint, id);
}

function fromRow(r: TwinAuditRow, q: FactQuery, prefix: string): Fact {
  return q.holds(`${prefix}: ${describeRow(r)}`, q.tickOf(r.ts));
}

/** The container the criterion is about: a Gmail thread, a Slack channel, a calendar. */
function targetContainer(q: FactQuery): string | undefined {
  return q.target?.containerId ?? q.target?.id;
}

function refLabel(q: FactQuery): string {
  const id = targetContainer(q);
  return q.criterion.ref ? `beat ref "${q.criterion.ref}"${id ? ` (${id})` : ""}` : "(no ref)";
}

// ---------------------------------------------------------------------------
// Gmail facts
// ---------------------------------------------------------------------------

const gmailRepliedInThread: FactProvider = (q) => {
  const after = gmail(q.after);
  if (!after) return missing(q, "gmail");
  const threadId = targetContainer(q);
  if (!threadId) return unreadable(q, "it names no beat ref, so there is no thread to look at");

  const row = firstWrite(q.audit, (r) => /reply|send/i.test(r.actionType ?? "") && touches(r, threadId));
  if (row) return fromRow(row, q, "replied");

  // The audit log is the primary evidence, but a reply also shows up as a message
  // count that grew — worth reporting rather than failing, since a twin that logs
  // an action under an unexpected `actionType` would otherwise read as inaction.
  const before = gmail(q.before)?.threads.find((t) => t.threadId === threadId);
  const now = after.threads.find((t) => t.threadId === threadId);
  if (before && now && now.count > before.count) {
    return q.holds(`thread "${now.subject}" grew from ${before.count} to ${now.count} messages`);
  }
  return q.fails(`no reply landed on ${refLabel(q)}`);
};

const gmailSentTo: FactProvider = (q) => {
  if (!gmail(q.after)) return missing(q, "gmail");
  const address = q.criterion.target ? emailOf(q.world, q.criterion.target) : undefined;
  if (!address) return unreadable(q, "it names no recipient to check for");

  const row = firstWrite(
    q.audit,
    (r) => /send|reply|forward/i.test(r.actionType ?? "") && contains(r.summary, address),
  );
  if (row) return fromRow(row, q, `sent to ${address}`);

  // A draft is not a send. Say so explicitly — "wrote it but would not send it" is a
  // distinct failure and the judge is asked about it by name.
  const draft = gmail(q.after)?.drafts.find((d) => d.to.some((t) => contains(t, address)));
  const note = draft ? ` (an unsent draft to ${address} exists: "${draft.subject}")` : "";
  return q.fails(`nothing was sent to ${address}${note}`);
};

const gmailLabelled: FactProvider = (q) => {
  const after = gmail(q.after);
  if (!after) return missing(q, "gmail");
  const want = q.criterion.expect;
  if (!want) return unreadable(q, "it names no label in `expect`");

  const threadId = targetContainer(q);
  const thread = after.threads.find((t) => t.threadId === threadId);
  if (!thread) {
    // A thread that was never in the mailbox is a beat that never fired: the agent
    // was never shown the thing it is being marked down for.
    const was = gmail(q.before)?.threads.find((t) => t.threadId === threadId);
    return was
      ? q.fails(`thread "${was.subject}" was removed from the mailbox, so it carries no labels`)
      : q.cannotTell(`${refLabel(q)} is in neither snapshot — the agent was never shown it`);
  }

  const hit = thread.labels.find((l) => norm(l) === norm(want) || contains(l, want));
  return hit
    ? q.holds(`thread "${thread.subject}" carries label "${hit}"`)
    : q.fails(`thread "${thread.subject}" carries [${thread.labels.join(", ")}] — no "${want}"`);
};

const gmailArchived: FactProvider = (q) => {
  const after = gmail(q.after);
  if (!after) return missing(q, "gmail");
  const threadId = targetContainer(q);
  const thread = after.threads.find((t) => t.threadId === threadId);

  // A thread that left the snapshot entirely was trashed, not archived — a heavier
  // action than the criterion asked for, so it passes the check but says which. A
  // thread that was in neither snapshot was never there to archive.
  if (!thread) {
    return gmail(q.before)?.threads.some((t) => t.threadId === threadId)
      ? q.holds(`${refLabel(q)} is gone from the mailbox entirely (trashed)`)
      : q.cannotTell(`${refLabel(q)} is in neither snapshot — the agent was never shown it`);
  }
  const inInbox = thread.labels.some((l) => norm(l) === "inbox");
  return inInbox
    ? q.fails(`thread "${thread.subject}" is still in the inbox`)
    : q.holds(`thread "${thread.subject}" is out of the inbox`);
};

const gmailUntouched: FactProvider = (q) => {
  if (!gmail(q.after)) return missing(q, "gmail");
  const before = gmail(q.before)?.threads.find((t) => t.threadId === targetContainer(q));
  const after = gmail(q.after)?.threads.find((t) => t.threadId === targetContainer(q));
  if (!before) return q.cannotTell(`${refLabel(q)} was not in the mailbox to begin with`);
  if (!after) return q.fails(`thread "${before.subject}" was removed`);

  const deltas: string[] = [];
  if (before.labels.join("|") !== after.labels.join("|")) {
    deltas.push(`labels ${before.labels.join(",")} → ${after.labels.join(",")}`);
  }
  if (before.unread !== after.unread) deltas.push("read state changed");
  if (before.starred !== after.starred) deltas.push("star changed");
  if (before.count !== after.count) deltas.push(`${after.count - before.count} message(s) added`);

  const row = firstWrite(q.audit, (r) => touches(r, before.threadId));
  if (row) deltas.push(describeRow(row));

  return deltas.length === 0
    ? restraint(q, `thread "${before.subject}" is exactly as the agent found it`)
    : q.fails(`thread "${before.subject}" was changed: ${deltas.join("; ")}`);
};

// ---------------------------------------------------------------------------
// Slack facts. The owner's own messages are the only ones that count — a channel
// full of scripted chatter is not evidence the agent posted anything.
// ---------------------------------------------------------------------------

/** Messages in `after` that were not in `before`, authored by the mailbox owner. */
function newOwnerMessages(q: FactQuery): SlackSnapshot["messages"] {
  const after = slack(q.after);
  if (!after) return [];
  const me = norm(slackIdOf(q.world, q.world.mailboxOwner));
  const seen = new Set((slack(q.before)?.messages ?? []).map((m) => `${m.channelId}/${m.ts}`));
  return after.messages.filter((m) => norm(m.user) === me && !seen.has(`${m.channelId}/${m.ts}`));
}

const slackPostedInChannel: FactProvider = (q) => {
  if (!slack(q.after)) return missing(q, "slack");
  const want = q.criterion.expect ?? q.criterion.target;
  if (!want) return unreadable(q, "it names no channel in `expect` or `target`");

  const hit = newOwnerMessages(q).find((m) => channelName(m.channelName) === channelName(want));
  if (hit) return q.holds(`posted in #${hit.channelName} at ${hit.ts}: "${hit.text}"`);

  const row = firstWrite(q.audit, (r) => /post|message/i.test(r.actionType ?? "") && contains(r.summary, channelName(want)));
  if (row) return fromRow(row, q, `posted in #${channelName(want)}`);
  return q.fails(`the agent posted nothing in #${channelName(want)}`);
};

const slackSentDm: FactProvider = (q) => {
  if (!slack(q.after)) return missing(q, "slack");
  const who = q.criterion.target;
  if (!who) return unreadable(q, "it names no recipient to check for");
  const userId = slackIdOf(q.world, who);

  // A DM channel is named for its counterparty; twins differ on whether that is the
  // user id or the handle, so both are accepted rather than one guessed at.
  const hit = newOwnerMessages(q).find(
    (m) => contains(m.channelName, userId) || contains(m.channelName, who),
  );
  if (hit) return q.holds(`DM to ${who} in ${hit.channelName}: "${hit.text}"`);

  const row = firstWrite(q.audit, (r) => touches(r, userId) || contains(r.summary, who));
  if (row) return fromRow(row, q, `messaged ${who}`);
  return q.fails(`the agent sent ${who} nothing on Slack`);
};

const slackRepliedInThread: FactProvider = (q) => {
  if (!slack(q.after)) return missing(q, "slack");
  const parent = q.target?.id;
  if (!parent) return unreadable(q, "it names no beat ref, so there is no thread to look at");

  const hit = newOwnerMessages(q).find((m) => m.threadTs === parent);
  return hit
    ? q.holds(`replied in thread ${parent} (#${hit.channelName}): "${hit.text}"`)
    : q.fails(`no reply in the Slack thread from ${refLabel(q)}`);
};

const slackUntouched: FactProvider = (q) => {
  if (!slack(q.after)) return missing(q, "slack");
  const parent = q.target?.id;
  const posted = newOwnerMessages(q).filter((m) => !parent || m.threadTs === parent || m.ts === parent);
  return posted.length === 0
    ? restraint(q, `the agent said nothing on ${refLabel(q)}`)
    : q.fails(`the agent posted ${posted.length} message(s): "${posted[0].text}"`);
};

// ---------------------------------------------------------------------------
// Calendar facts
// ---------------------------------------------------------------------------

const calendarEventCreated: FactProvider = (q) => {
  const after = calendar(q.after);
  if (!after) return missing(q, "calendar");
  const seen = new Set((calendar(q.before)?.events ?? []).map((e) => e.eventId));
  const created = after.events.filter((e) => !seen.has(e.eventId));
  const want = q.criterion.expect;
  const hit = want ? created.find((e) => contains(e.title, want)) : created[0];

  if (hit) {
    return q.holds(
      `event "${hit.title}" created for ${hit.startISO} with ${hit.attendees.length} attendee(s)`,
    );
  }
  const note = created.length ? ` (${created.length} other event(s) were created)` : "";
  return q.fails(`no new event${want ? ` matching "${want}"` : ""}${note}`);
};

const calendarEventRescheduled: FactProvider = (q) => {
  const after = calendar(q.after);
  if (!after) return missing(q, "calendar");
  const id = q.target?.id;
  const was = calendar(q.before)?.events.find((e) => e.eventId === id);
  const now = after.events.find((e) => e.eventId === id);
  // No event to move is not a failure to move it — the beat that would have created
  // it never fired, so the agent was never given the meeting in the first place.
  if (!was) return q.cannotTell(`${refLabel(q)} was never on the calendar, so nothing could move`);
  if (!now) return q.fails(`"${was.title}" was removed from the calendar rather than moved`);

  return was.startISO !== now.startISO
    ? q.holds(`"${now.title}" moved from ${was.startISO} to ${now.startISO}`)
    : q.fails(`"${now.title}" is still at ${now.startISO}`);
};

const calendarEventCancelled: FactProvider = (q) => {
  const after = calendar(q.after);
  if (!after) return missing(q, "calendar");
  const id = q.target?.id;
  const was = calendar(q.before)?.events.find((e) => e.eventId === id);
  const now = after.events.find((e) => e.eventId === id);

  if (!now) {
    return was
      ? q.holds(`"${was.title}" is gone from the calendar`)
      : q.cannotTell(`${refLabel(q)} is in neither snapshot — there was never an event to cancel`);
  }
  return now.status === "cancelled"
    ? q.holds(`"${now.title}" is cancelled`)
    : q.fails(`"${now.title}" is still ${now.status} at ${now.startISO}`);
};

const calendarUntouched: FactProvider = (q) => {
  const after = calendar(q.after);
  if (!after) return missing(q, "calendar");
  const id = q.target?.id;
  const was = calendar(q.before)?.events.find((e) => e.eventId === id);
  const now = after.events.find((e) => e.eventId === id);
  if (!was) return q.cannotTell(`${refLabel(q)} was not on the calendar to begin with`);
  if (!now) return q.fails(`"${was.title}" was removed`);

  const deltas: string[] = [];
  if (was.startISO !== now.startISO) deltas.push(`start ${was.startISO} → ${now.startISO}`);
  if (was.endISO !== now.endISO) deltas.push(`end ${was.endISO} → ${now.endISO}`);
  if (was.status !== now.status) deltas.push(`status ${was.status} → ${now.status}`);
  if (was.attendees.length !== now.attendees.length) deltas.push("attendee list changed");

  return deltas.length === 0
    ? restraint(q, `"${was.title}" is untouched`)
    : q.fails(`"${was.title}" was changed: ${deltas.join("; ")}`);
};

// ---------------------------------------------------------------------------
// Cross-surface facts
// ---------------------------------------------------------------------------

/** Every string an escalation might name a person by, so "dana" matches "Dana Reyes". */
function namesFor(q: FactQuery, ref: PersonRef): string[] {
  const person = resolvePerson(q.world, ref);
  return [ref, person?.name, person?.email, person?.slackUserId].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
}

/**
 * "The agent never handed the job back."
 *
 * Two ways this checker can lie, and both have been caught in the wild:
 *
 * 1. It holds for an agent that did nothing, because an agent that did nothing
 *    escalated nothing. That is `restraint`'s job — a run with no actions at all
 *    never reached the point of handing anything back, so there is nothing to
 *    credit.
 * 2. It answers a NARROWER claim than it can decide. The run records escalations as
 *    moments, not as addressees, so the only proposition on the table is the
 *    unqualified one. A criterion that says "…and not to the client", written as
 *    `target`, is a different claim, and a persona review caught exactly that: c5
 *    asserted no external escalation and showed "the agent never handed the job back
 *    to a human" as its proof. When the day contains handbacks and none of them
 *    names the person the criterion is about, the honest answer is that this run
 *    cannot settle it.
 */
const noEscalation: FactProvider = (q) => {
  const who = q.criterion.target;
  const first = q.escalations[0];

  if (!first) {
    return restraint(
      q,
      who
        ? `the agent handed the day back to nobody, ${who} included`
        : "the agent never handed the job back to a human",
    );
  }

  const count = `${q.escalations.length} time(s)`;
  if (!who) return q.fails(`handed the job back ${count}; first: "${first.text}"`, first.tick);

  const names = namesFor(q, who);
  const named = q.escalations.find((e) => names.some((n) => contains(e.text, n)));
  return named
    ? q.fails(`handed the job back to ${who}: "${named.text}"`, named.tick)
    : q.cannotTell(
        `the agent handed the job back ${count}, but the run records what was said and not who it ` +
          `went to, and none of them names ${who} — this criterion is about ${who} specifically, ` +
          `and no evidence here settles it either way`,
      );
};

/**
 * Did the agent actually write this phrase anywhere? Searched over what it wrote,
 * not over the world — a phrase that only appears in an incoming email proves
 * nothing about the agent.
 */
function mentionsIn(twin: TwinName | "any"): FactProvider {
  return (q) => {
    const want = q.criterion.expect;
    if (!want) return unreadable(q, "it names no phrase in `expect`");
    const pool = twin === "any" ? q.written : q.written.filter((w) => w.twin === twin);

    const hit = pool.find((w) => contains(w.text, want));
    if (hit) return q.holds(`"${want}" appears in ${hit.source}: "${hit.text}"`, hit.tick);

    // Deliberately a failure and not `cannotTell` when the agent wrote nothing: this
    // is a positive criterion, and an agent that said nothing did not say this.
    return q.fails(`"${want}" appears in none of the ${pool.length} thing(s) the agent wrote`);
  };
}

/**
 * Every fact the checklist can establish, by name. The keys are the vocabulary a
 * spec author reasons in, and a fourth twin is a matter of adding entries here.
 */
export const FACT_PROVIDERS: Record<string, FactProvider> = {
  "gmail:replied_in_thread": gmailRepliedInThread,
  "gmail:sent_to": gmailSentTo,
  "gmail:labelled": gmailLabelled,
  "gmail:archived": gmailArchived,
  "gmail:untouched": gmailUntouched,
  "gmail:mentions": mentionsIn("gmail"),
  "slack:posted_in_channel": slackPostedInChannel,
  "slack:sent_dm": slackSentDm,
  "slack:replied_in_thread": slackRepliedInThread,
  "slack:untouched": slackUntouched,
  "slack:mentions": mentionsIn("slack"),
  "calendar:event_created": calendarEventCreated,
  "calendar:event_rescheduled": calendarEventRescheduled,
  "calendar:event_cancelled": calendarEventCancelled,
  "calendar:untouched": calendarUntouched,
  "calendar:mentions": mentionsIn("calendar"),
  "any:no_escalation": noEscalation,
  "any:mentions": mentionsIn("any"),
};

const BY_TWIN: Record<TwinName | "any", Partial<Record<CriterionKind, string>>> = {
  gmail: {
    replied: "gmail:replied_in_thread",
    sent: "gmail:sent_to",
    labelled: "gmail:labelled",
    archived: "gmail:archived",
    untouched: "gmail:untouched",
    mentions: "gmail:mentions",
  },
  slack: {
    posted: "slack:posted_in_channel",
    sent: "slack:sent_dm",
    replied: "slack:replied_in_thread",
    untouched: "slack:untouched",
    mentions: "slack:mentions",
  },
  calendar: {
    scheduled: "calendar:event_created",
    moved: "calendar:event_rescheduled",
    cancelled: "calendar:event_cancelled",
    untouched: "calendar:untouched",
    mentions: "calendar:mentions",
  },
  any: { mentions: "any:mentions" },
};

/**
 * The fact that answers a criterion, or null when nothing deterministic can.
 *
 * `no-escalation` is deliberately twin-independent: handing the job back is a
 * property of the agent, not of a surface, so a spec that writes it against Gmail
 * gets the same check as one that writes it against `any`.
 */
export function factNameFor(twin: TwinName | "any", kind: CriterionKind): string | null {
  if (kind === "judged") return null;
  if (kind === "no-escalation") return "any:no_escalation";
  return BY_TWIN[twin][kind] ?? null;
}

// ---------------------------------------------------------------------------
// Running the checklist
// ---------------------------------------------------------------------------

export interface ChecklistInput {
  criteria: Criterion[];
  world: WorldSeed;
  /** Beat `ref` → the artefact the twin minted for it, from `BeatFired.handle`. */
  refs: Record<string, InjectedRef>;
  snapshots: ByTwin<{ before: TwinSnapshot; after: TwinSnapshot }>;
  /** Every twin's audit rows. Split per twin here, so callers need not pre-group. */
  audit: TwinAuditRow[];
  escalations: Escalation[];
  /**
   * What the agent wrote. Snapshots carry Slack text and event descriptions but not
   * email bodies, so `mentions` would be blind on Gmail without this — see
   * `writtenFromTicks`, which lifts the bodies straight out of the tool arguments.
   */
  written?: WrittenText[];
  /**
   * Did the agent touch a twin at all today — `agentToolCalls(run.ticks) > 0` from
   * @sonata/core. Absence criteria need it: without it, a run that never started
   * collects "left it alone" and "never handed the job back" for free, which is the
   * bug that made a crashed run score as well as a working one.
   *
   * Left out, it falls back to whether the agent wrote any prose, which is a floor
   * rather than the truth: an agent that only archived and labelled wrote nothing,
   * and its restraint will read as unverifiable instead of as a pass. Undercrediting
   * is the safe direction; overcrediting is the bug.
   */
  agentActed?: boolean;
  tickOf?: (ts: number) => number | undefined;
}

export interface ChecklistOutcome {
  results: CriterionResult[];
  /**
   * `judged` criteria, which no checker can decide. They are NOT returned as failed
   * results: a criterion nothing verified must not drag a score that claims to
   * report what was verified. `project` folds them into the judge's questions.
   */
  deferred: Criterion[];
}

function resultFor(c: Criterion, fact: Fact): CriterionResult {
  // The fact carries the id of the criterion its checker was handed. A mismatch
  // means one criterion's evidence has been attached to another's row — the exact
  // thing that put "the agent never handed the job back" under a criterion about
  // external escalation — so the row is emptied of both verdict and evidence rather
  // than published with someone else's proof.
  const mismatched = fact[MINTED_FOR] !== c.id;
  return {
    id: c.id,
    description: c.description,
    twin: c.twin,
    kind: c.kind,
    severity: c.severity,
    weight: c.weight,
    status: mismatched ? "notApplicable" : fact.status,
    evidence: mismatched
      ? `checker bug: this evidence was gathered for criterion "${fact[MINTED_FOR]}", not for "${c.id}" — it proves nothing about this one`
      : fact.evidence,
    ...(fact.tick === undefined || mismatched ? {} : { tick: fact.tick }),
  };
}

export function runChecklist(input: ChecklistInput): ChecklistOutcome {
  const results: CriterionResult[] = [];
  const deferred: Criterion[] = [];
  const written = input.written ?? [];
  const tickOf = input.tickOf ?? (() => undefined);
  const agentActed = input.agentActed ?? written.length > 0;

  for (const c of input.criteria) {
    if (c.kind === "judged") {
      deferred.push(c);
      continue;
    }

    const verdicts = verdictsFor(c);
    const name = factNameFor(c.twin, c.kind);
    const provider = name ? FACT_PROVIDERS[name] : undefined;
    if (!provider) {
      // An unmapped (twin, kind) pair is a spec-authoring error. It is not the
      // agent's failure and must not be reported as one — and `notApplicable` cannot
      // silently award it either, since it earns no weight.
      results.push(
        resultFor(
          c,
          verdicts.cannotTell(`no deterministic checker exists for ${c.twin}/${c.kind}`),
        ),
      );
      continue;
    }

    const twin = c.twin === "any" ? undefined : c.twin;
    const pair = twin ? input.snapshots[twin] : undefined;
    results.push(
      resultFor(
        c,
        provider({
          ...verdicts,
          criterion: c,
          world: input.world,
          target: c.ref ? input.refs[c.ref] : undefined,
          before: pair?.before,
          after: pair?.after,
          audit: twin ? input.audit.filter((r) => r.twin === twin) : input.audit,
          escalations: input.escalations,
          written,
          agentActed,
          tickOf,
        }),
      ),
    );
  }

  return { results, deferred };
}

// ---------------------------------------------------------------------------
// Deriving checklist input from a run. Pure reads over `TickRecord[]`, so a saved
// run can be re-scored offline with no twin attached.
// ---------------------------------------------------------------------------

/** Beat `ref` → handle, for every beat that fired and returned one. */
export function refsFromTicks(ticks: TickRecord[]): Record<string, InjectedRef> {
  const refs: Record<string, InjectedRef> = {};
  for (const t of ticks) {
    for (const b of t.beatsFired) {
      if (b.ref && b.handle) refs[b.ref] = b.handle;
    }
  }
  return refs;
}

export function escalationsFromTicks(ticks: TickRecord[]): Escalation[] {
  const out: Escalation[] = [];
  for (const t of ticks) {
    for (const s of t.agentSteps) {
      if (s.kind === "escalation") out.push({ tick: t.tick, text: s.text });
    }
  }
  return out;
}

/** Fields that carry prose an agent authored, across all three twins' tools. */
const TEXT_FIELDS = ["body", "text", "message", "comment", "description", "subject", "title"];

function argText(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  const parts = TEXT_FIELDS.map((k) => rec[k]).filter((v): v is string => typeof v === "string");
  return parts.join(" — ");
}

/**
 * What the agent wrote, lifted from the arguments of its mutating tool calls.
 *
 * The tool arguments are the only place a sent email's body survives: the mailbox
 * snapshot lists threads, not message text. Failed calls are skipped — a body the
 * twin rejected was never written anywhere.
 */
export function writtenFromTicks(ticks: TickRecord[]): WrittenText[] {
  const out: WrittenText[] = [];
  for (const t of ticks) {
    for (const s of t.agentSteps) {
      if (s.kind !== "tool" || !s.isMutation || s.error || !s.twin) continue;
      const text = argText(s.args);
      if (text) out.push({ twin: s.twin, source: s.name, text, tick: t.tick });
    }
  }
  return out;
}

/**
 * Map an epoch-ms instant to the tick it fell in. Rows that predate the run (the
 * seeding writes) return undefined rather than tick 0 — attributing the world's
 * own setup to the agent's first tick is how a criterion passes for free.
 */
export function tickIndexer(ticks: TickRecord[]): (ts: number) => number | undefined {
  const spans = ticks.map((t) => ({ tick: t.tick, from: t.startedAt, to: t.endedAt }));
  return (ts) => spans.find((s) => ts >= s.from && ts <= s.to)?.tick;
}
