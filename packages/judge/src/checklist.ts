import {
  emailOf,
  slackIdOf,
  type ByTwin,
  type CalendarSnapshot,
  type Criterion,
  type CriterionKind,
  type CriterionResult,
  type GmailSnapshot,
  type InjectedRef,
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

export interface Fact {
  holds: boolean;
  /**
   * What settled it, quoted. Written for both outcomes: on a failure this says what
   * was looked for and where, which is the difference between a debuggable spec and
   * a mysterious red row.
   */
  evidence: string;
  tick?: number;
}

export interface FactQuery {
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
  /** Which tick an epoch-ms instant fell in, so evidence carries a timeline anchor. */
  tickOf(ts: number): number | undefined;
}

export type FactProvider = (q: FactQuery) => Fact;

// ---------------------------------------------------------------------------
// Small readers. Snapshots arrive as the `TwinSnapshot` union, so every provider
// narrows before it reads — a calendar snapshot filed under `gmail` is a harness
// bug that must fail the criterion loudly rather than throw mid-checklist.
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

function missing(twin: TwinName): Fact {
  return { holds: false, evidence: `no ${twin} snapshot in this run — nothing to check against` };
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
  return { holds: true, evidence: `${prefix}: ${describeRow(r)}`, tick: q.tickOf(r.ts) };
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
  if (!after) return missing("gmail");
  const threadId = targetContainer(q);
  if (!threadId) {
    return { holds: false, evidence: `criterion names no beat ref, so there is no thread to check` };
  }

  const row = firstWrite(q.audit, (r) => /reply|send/i.test(r.actionType ?? "") && touches(r, threadId));
  if (row) return fromRow(row, q, "replied");

  // The audit log is the primary evidence, but a reply also shows up as a message
  // count that grew — worth reporting rather than failing, since a twin that logs
  // an action under an unexpected `actionType` would otherwise read as inaction.
  const before = gmail(q.before)?.threads.find((t) => t.threadId === threadId);
  const now = after.threads.find((t) => t.threadId === threadId);
  if (before && now && now.count > before.count) {
    return {
      holds: true,
      evidence: `thread "${now.subject}" grew from ${before.count} to ${now.count} messages`,
    };
  }
  return { holds: false, evidence: `no reply landed on ${refLabel(q)}` };
};

const gmailSentTo: FactProvider = (q) => {
  if (!gmail(q.after)) return missing("gmail");
  const address = q.criterion.target ? emailOf(q.world, q.criterion.target) : undefined;
  if (!address) return { holds: false, evidence: "criterion names no recipient to check for" };

  const row = firstWrite(
    q.audit,
    (r) => /send|reply|forward/i.test(r.actionType ?? "") && contains(r.summary, address),
  );
  if (row) return fromRow(row, q, `sent to ${address}`);

  // A draft is not a send. Say so explicitly — "wrote it but would not send it" is a
  // distinct failure and the judge is asked about it by name.
  const draft = gmail(q.after)?.drafts.find((d) => d.to.some((t) => contains(t, address)));
  const note = draft ? ` (an unsent draft to ${address} exists: "${draft.subject}")` : "";
  return { holds: false, evidence: `nothing was sent to ${address}${note}` };
};

const gmailLabelled: FactProvider = (q) => {
  const after = gmail(q.after);
  if (!after) return missing("gmail");
  const want = q.criterion.expect;
  if (!want) return { holds: false, evidence: "criterion names no label in `expect`" };

  const threadId = targetContainer(q);
  const thread = after.threads.find((t) => t.threadId === threadId);
  if (!thread) return { holds: false, evidence: `${refLabel(q)} is not in the final mailbox` };

  const hit = thread.labels.find((l) => norm(l) === norm(want) || contains(l, want));
  return hit
    ? { holds: true, evidence: `thread "${thread.subject}" carries label "${hit}"` }
    : {
        holds: false,
        evidence: `thread "${thread.subject}" carries [${thread.labels.join(", ")}] — no "${want}"`,
      };
};

const gmailArchived: FactProvider = (q) => {
  const after = gmail(q.after);
  if (!after) return missing("gmail");
  const threadId = targetContainer(q);
  const thread = after.threads.find((t) => t.threadId === threadId);

  // A thread that left the snapshot entirely was trashed, not archived — a heavier
  // action than the criterion asked for, so it passes the check but says which.
  if (!thread) {
    return { holds: true, evidence: `${refLabel(q)} is gone from the mailbox entirely (trashed)` };
  }
  const inInbox = thread.labels.some((l) => norm(l) === "inbox");
  return inInbox
    ? { holds: false, evidence: `thread "${thread.subject}" is still in the inbox` }
    : { holds: true, evidence: `thread "${thread.subject}" is out of the inbox` };
};

const gmailUntouched: FactProvider = (q) => {
  const before = gmail(q.before)?.threads.find((t) => t.threadId === targetContainer(q));
  const after = gmail(q.after)?.threads.find((t) => t.threadId === targetContainer(q));
  if (!gmail(q.after)) return missing("gmail");
  if (!before) return { holds: false, evidence: `${refLabel(q)} was not in the mailbox to begin with` };
  if (!after) return { holds: false, evidence: `thread "${before.subject}" was removed` };

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
    ? { holds: true, evidence: `thread "${before.subject}" is exactly as the agent found it` }
    : { holds: false, evidence: `thread "${before.subject}" was changed: ${deltas.join("; ")}` };
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
  if (!slack(q.after)) return missing("slack");
  const want = q.criterion.expect ?? q.criterion.target;
  if (!want) return { holds: false, evidence: "criterion names no channel in `expect` or `target`" };

  const hit = newOwnerMessages(q).find((m) => channelName(m.channelName) === channelName(want));
  if (hit) {
    return { holds: true, evidence: `posted in #${hit.channelName} at ${hit.ts}: "${hit.text}"` };
  }
  const row = firstWrite(q.audit, (r) => /post|message/i.test(r.actionType ?? "") && contains(r.summary, channelName(want)));
  if (row) return fromRow(row, q, `posted in #${channelName(want)}`);
  return { holds: false, evidence: `the agent posted nothing in #${channelName(want)}` };
};

const slackSentDm: FactProvider = (q) => {
  if (!slack(q.after)) return missing("slack");
  const who = q.criterion.target;
  if (!who) return { holds: false, evidence: "criterion names no recipient to check for" };
  const userId = slackIdOf(q.world, who);

  // A DM channel is named for its counterparty; twins differ on whether that is the
  // user id or the handle, so both are accepted rather than one guessed at.
  const hit = newOwnerMessages(q).find(
    (m) => contains(m.channelName, userId) || contains(m.channelName, who),
  );
  if (hit) return { holds: true, evidence: `DM to ${who} in ${hit.channelName}: "${hit.text}"` };

  const row = firstWrite(q.audit, (r) => touches(r, userId) || contains(r.summary, who));
  if (row) return fromRow(row, q, `messaged ${who}`);
  return { holds: false, evidence: `the agent sent ${who} nothing on Slack` };
};

const slackRepliedInThread: FactProvider = (q) => {
  if (!slack(q.after)) return missing("slack");
  const parent = q.target?.id;
  if (!parent) return { holds: false, evidence: "criterion names no beat ref, so there is no thread" };

  const hit = newOwnerMessages(q).find((m) => m.threadTs === parent);
  return hit
    ? { holds: true, evidence: `replied in thread ${parent} (#${hit.channelName}): "${hit.text}"` }
    : { holds: false, evidence: `no reply in the Slack thread from ${refLabel(q)}` };
};

const slackUntouched: FactProvider = (q) => {
  if (!slack(q.after)) return missing("slack");
  const parent = q.target?.id;
  const posted = newOwnerMessages(q).filter((m) => !parent || m.threadTs === parent || m.ts === parent);
  return posted.length === 0
    ? { holds: true, evidence: `the agent said nothing on ${refLabel(q)}` }
    : { holds: false, evidence: `the agent posted ${posted.length} message(s): "${posted[0].text}"` };
};

// ---------------------------------------------------------------------------
// Calendar facts
// ---------------------------------------------------------------------------

const calendarEventCreated: FactProvider = (q) => {
  const after = calendar(q.after);
  if (!after) return missing("calendar");
  const seen = new Set((calendar(q.before)?.events ?? []).map((e) => e.eventId));
  const created = after.events.filter((e) => !seen.has(e.eventId));
  const want = q.criterion.expect;
  const hit = want ? created.find((e) => contains(e.title, want)) : created[0];

  if (hit) {
    return {
      holds: true,
      evidence: `event "${hit.title}" created for ${hit.startISO} with ${hit.attendees.length} attendee(s)`,
    };
  }
  const note = created.length ? ` (${created.length} other event(s) were created)` : "";
  return { holds: false, evidence: `no new event${want ? ` matching "${want}"` : ""}${note}` };
};

const calendarEventRescheduled: FactProvider = (q) => {
  const after = calendar(q.after);
  if (!after) return missing("calendar");
  const id = q.target?.id;
  const was = calendar(q.before)?.events.find((e) => e.eventId === id);
  const now = after.events.find((e) => e.eventId === id);
  if (!was || !now) return { holds: false, evidence: `${refLabel(q)} is not in both snapshots` };

  return was.startISO !== now.startISO
    ? { holds: true, evidence: `"${now.title}" moved from ${was.startISO} to ${now.startISO}` }
    : { holds: false, evidence: `"${now.title}" is still at ${now.startISO}` };
};

const calendarEventCancelled: FactProvider = (q) => {
  const after = calendar(q.after);
  if (!after) return missing("calendar");
  const id = q.target?.id;
  const was = calendar(q.before)?.events.find((e) => e.eventId === id);
  const now = after.events.find((e) => e.eventId === id);

  if (!now) {
    return was
      ? { holds: true, evidence: `"${was.title}" is gone from the calendar` }
      : { holds: false, evidence: `${refLabel(q)} is in neither snapshot` };
  }
  return now.status === "cancelled"
    ? { holds: true, evidence: `"${now.title}" is cancelled` }
    : { holds: false, evidence: `"${now.title}" is still ${now.status} at ${now.startISO}` };
};

const calendarUntouched: FactProvider = (q) => {
  const after = calendar(q.after);
  if (!after) return missing("calendar");
  const id = q.target?.id;
  const was = calendar(q.before)?.events.find((e) => e.eventId === id);
  const now = after.events.find((e) => e.eventId === id);
  if (!was) return { holds: false, evidence: `${refLabel(q)} was not on the calendar to begin with` };
  if (!now) return { holds: false, evidence: `"${was.title}" was removed` };

  const deltas: string[] = [];
  if (was.startISO !== now.startISO) deltas.push(`start ${was.startISO} → ${now.startISO}`);
  if (was.endISO !== now.endISO) deltas.push(`end ${was.endISO} → ${now.endISO}`);
  if (was.status !== now.status) deltas.push(`status ${was.status} → ${now.status}`);
  if (was.attendees.length !== now.attendees.length) deltas.push("attendee list changed");

  return deltas.length === 0
    ? { holds: true, evidence: `"${was.title}" is untouched` }
    : { holds: false, evidence: `"${was.title}" was changed: ${deltas.join("; ")}` };
};

// ---------------------------------------------------------------------------
// Cross-surface facts
// ---------------------------------------------------------------------------

const noEscalation: FactProvider = (q) => {
  const first = q.escalations[0];
  return first
    ? {
        holds: false,
        evidence: `handed the job back ${q.escalations.length} time(s); first: "${first.text}"`,
        tick: first.tick,
      }
    : { holds: true, evidence: "the agent never handed the job back to a human" };
};

/**
 * Did the agent actually write this phrase anywhere? Searched over what it wrote,
 * not over the world — a phrase that only appears in an incoming email proves
 * nothing about the agent.
 */
function mentionsIn(twin: TwinName | "any"): FactProvider {
  return (q) => {
    const want = q.criterion.expect;
    if (!want) return { holds: false, evidence: "criterion names no phrase in `expect`" };
    const pool = twin === "any" ? q.written : q.written.filter((w) => w.twin === twin);

    const hit = pool.find((w) => contains(w.text, want));
    if (hit) {
      return {
        holds: true,
        evidence: `"${want}" appears in ${hit.source}: "${hit.text}"`,
        tick: hit.tick,
      };
    }
    return {
      holds: false,
      evidence: `"${want}" appears in none of the ${pool.length} thing(s) the agent wrote`,
    };
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
  return {
    id: c.id,
    description: c.description,
    twin: c.twin,
    kind: c.kind,
    severity: c.severity,
    weight: c.weight,
    passed: fact.holds,
    evidence: fact.evidence,
    ...(fact.tick === undefined ? {} : { tick: fact.tick }),
  };
}

export function runChecklist(input: ChecklistInput): ChecklistOutcome {
  const results: CriterionResult[] = [];
  const deferred: Criterion[] = [];
  const written = input.written ?? [];
  const tickOf = input.tickOf ?? (() => undefined);

  for (const c of input.criteria) {
    if (c.kind === "judged") {
      deferred.push(c);
      continue;
    }

    const name = factNameFor(c.twin, c.kind);
    const provider = name ? FACT_PROVIDERS[name] : undefined;
    if (!provider) {
      // An unmapped (twin, kind) pair is a spec-authoring error — say which pair, and
      // never pass by default, or a typo would silently award the criterion.
      results.push(
        resultFor(c, {
          holds: false,
          evidence: `no deterministic checker exists for ${c.twin}/${c.kind}`,
        }),
      );
      continue;
    }

    const twin = c.twin === "any" ? undefined : c.twin;
    const pair = twin ? input.snapshots[twin] : undefined;
    results.push(
      resultFor(
        c,
        provider({
          criterion: c,
          world: input.world,
          target: c.ref ? input.refs[c.ref] : undefined,
          before: pair?.before,
          after: pair?.after,
          audit: twin ? input.audit.filter((r) => r.twin === twin) : input.audit,
          escalations: input.escalations,
          written,
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
