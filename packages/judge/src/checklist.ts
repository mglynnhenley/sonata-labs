import {
  asCriterionKind,
  CRITERION_KINDS,
  emailOf,
  harnessDefectEvidence,
  resolvePerson,
  slackIdOf,
  withheld,
  type ByTwin,
  type CalendarSnapshot,
  type Criterion,
  type CriterionKind,
  type CriterionResult,
  type CriterionStatus,
  type GmailSnapshot,
  type InjectedRef,
  type PersonRef,
  type RunTruncation,
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
//
// One rule runs through every provider here: A DRAFT IS NOT A SEND. An agent that
// writes the reply, writes the customer note, writes the summary and sends none of
// them has not done the job — it has asked instead of acted, which is the failure
// mode this benchmark exists to measure. Gmail files a draft AS a message inside its
// thread, and Slack's `chat.scheduleMessage` and `conversations.open` both leave a
// write in the log, so every "did it land?" check nets those out before it counts
// anything, and says on the row when it found one. Passing a run for work it parked
// is worse than failing it, because it looks like a result.

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
  /**
   * Every twin's snapshots. Only the `any`-twin providers read this: a criterion
   * filed under `any` is a claim about the day rather than about one surface, and
   * it can only be settled by putting the same question to each surface in turn.
   */
  snapshots: ByTwin<{ before: TwinSnapshot; after: TwinSnapshot }>;
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
 * The criterion is broader than the checker, so the checker must not answer it.
 *
 * Distinct from `unreadable`, which is "there is nothing here to look at". This is
 * "there is something to look at, but the question I would be answering is not the
 * question that was asked" — a `slack:untouched` with no beat ref would settle "the
 * agent posted nothing on Slack all day", which is a claim about the whole surface
 * and not about the thread the criterion is written for. Answering it and printing
 * the answer under the criterion's own words is how a run gets graded on a
 * proposition nobody wrote.
 */
function overbroad(q: FactQuery, wouldAnswer: string, insteadOf: string): Fact {
  return q.cannotTell(
    `this checker would have settled ${wouldAnswer}, which is not ${insteadOf} — ` +
      `the criterion names nothing to narrow it to, so nothing here decides it`,
  );
}

/**
 * The criterion points at a beat, and there is nothing at the end of the pointer.
 *
 * Two different situations used to print the same sentence, and the sentence was
 * true of only one of them. "It names no beat ref" is an authoring defect. But a
 * criterion that DOES name a ref whose beat never fired — the run stopped early,
 * the inject failed, the beat returned no handle — is a defect in the RUN, and the
 * agent was never shown the thread it is being measured on. The report that opened
 * this pass said "it names no beat ref" under three criteria that all named one:
 * their beats were scheduled for ticks the run never reached.
 *
 * Through `runChecklist` the second case no longer arrives here at all —
 * `harnessDefectFor` intercepts it, because it is ours and has to be labelled ours,
 * which no provider can do from inside its own question. This keeps its own answer
 * for a provider called directly, where there is no gate in front of it.
 */
function noTarget(q: FactQuery, what: string): Fact {
  const ref = q.criterion.ref;
  if (!ref) return unreadable(q, `it names no beat ref, so there is no ${what} to look at`);
  return q.cannotTell(
    `this criterion is about beat "${ref}", and this run recorded no artefact for it — the beat ` +
      `never fired, or failed when it did, so there is no ${what} here and the agent was never ` +
      `shown the thing it is being checked on`,
  );
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

/**
 * Did this row put something on the wire?
 *
 * Read off the twins' own `action_type` vocabulary: Gmail writes `send` and
 * `draftSend` for the two things that actually leave the mailbox, and
 * `draftCreate`/`draftUpdate` for the two that do not. A bare /send/ test gets
 * `draftSend` right by luck and would get a future `sendDraftLater` wrong, so the
 * parked verbs are excluded by name rather than by hoping the regex holds.
 */
function isSendRow(r: TwinAuditRow): boolean {
  const type = norm(r.actionType ?? "");
  if (/draftcreate|draftupdate|draftdelete/.test(type)) return false;
  return /send|reply|forward/.test(type);
}

/** Wrote it and stopped: a draft created or edited, never one sent. */
function isDraftRow(r: TwinAuditRow): boolean {
  const type = norm(r.actionType ?? "");
  return /draft/.test(type) && !/send/.test(type);
}

/** "Re: Re: SLA breach" and "SLA breach" are the same conversation. */
function bareSubject(s: string): string {
  return norm(s).replace(/^((re|fwd|fw):\s*)+/, "");
}

function sameSubject(a: string, b: string): boolean {
  const x = bareSubject(a);
  const y = bareSubject(b);
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
}

/**
 * Drafts parked on a thread.
 *
 * Gmail files a draft AS a message inside its thread — same `thread_id`, plus a
 * DRAFT label — so `thread.count` grows for a drafted reply exactly as it does for
 * a sent one. That is how a run in which the agent drafted four refund approvals
 * and sent none of them came back "replied": the count went up. Matched on
 * `threadId` only, never on subject, because this number decides a verdict and a
 * near-miss subject would net out a reply that really was sent.
 */
function draftsOnThread(s: GmailSnapshot | undefined, threadId: string): GmailSnapshot["drafts"] {
  return (s?.drafts ?? []).filter((d) => d.threadId === threadId);
}

/**
 * The unsent thing the agent wrote for this thread, quoted, or nothing.
 *
 * Used only to explain a failure, never to decide one, so it matches loosely —
 * by thread, then by subject, then by the log — where `draftsOnThread` matches
 * strictly. "Nobody replied" and "a reply was written and never sent" are the same
 * verdict and completely different findings, and the second one is the one the
 * judge is asked about by name.
 */
function unsentDraft(
  q: FactQuery,
  threadId: string,
  subject: string | undefined,
): { text: string; tick?: number } | undefined {
  const drafts = gmail(q.after)?.drafts ?? [];
  const draft =
    drafts.find((d) => d.threadId === threadId) ??
    (subject ? drafts.find((d) => sameSubject(d.subject, subject)) : undefined);
  if (draft) {
    const to = draft.to.length > 0 ? draft.to.join(", ") : "no recipient";
    return { text: `draft ${draft.draftId} to ${to} — "${draft.subject}": ${draft.excerpt}` };
  }

  // The mailbox is the better witness, but a draft the agent later deleted, or one
  // the twin filed under a thread of its own, survives only in the log.
  const row = firstWrite(
    q.audit,
    (r) => isDraftRow(r) && (touches(r, threadId) || (subject ? contains(r.summary, bareSubject(subject)) : false)),
  );
  return row ? { text: describeRow(row), tick: q.tickOf(row.ts) } : undefined;
}

// ---------------------------------------------------------------------------
// Gmail facts
// ---------------------------------------------------------------------------

/**
 * "The client got an answer on this thread."
 *
 * A REPLY IS A SENT MESSAGE. A draft is not a reply, and this checker must fail on
 * one rather than pass it or duck it: an agent that writes the answer and leaves it
 * in the drafts folder has asked instead of acted, which is a real, catalogued
 * failure mode and the most expensive one to miss. Both routes in used to miss it —
 * the log route because Gmail's `draftSend` and `draftCreate` both contain "draft",
 * and the snapshot route because a draft IS a message in its thread, so the count
 * grew either way. The run that prompted this fix drafted four refund approvals,
 * sent none, and was stamped passed at 100% autonomy.
 */
const gmailRepliedInThread: FactProvider = (q) => {
  const after = gmail(q.after);
  if (!after) return missing(q, "gmail");
  const threadId = targetContainer(q);
  if (!threadId) return noTarget(q, "thread");

  const row = firstWrite(q.audit, (r) => isSendRow(r) && touches(r, threadId));
  if (row) return fromRow(row, q, "replied");

  const before = gmail(q.before)?.threads.find((t) => t.threadId === threadId);
  const now = after.threads.find((t) => t.threadId === threadId);
  const subject = now?.subject ?? before?.subject;

  // The subject, because the thread id is not in the row. Gmail's `send` writes
  // `target_id` as the id of the NEW MESSAGE — the thread it joined appears nowhere
  // on the row — so the test above only ever fires for twins that log it. The rest
  // of the time this is the only witness the log has: `send_reply` sets the subject
  // to "Re: <original>", which `bareSubject` folds back onto the thread's own.
  //
  // Load-bearing, not a nicety. The `before` snapshot is taken before tick 0, so a
  // thread a beat creates during the day is in NEITHER the count route's snapshots,
  // and without this a real, sent reply on every beat-created thread — which is
  // every thread a `replied` criterion is allowed to name — fell through to "no
  // reply landed". Short subjects are skipped: "Re: Hi" would match half a mailbox.
  if (subject && bareSubject(subject).length >= 10) {
    const bySubject = firstWrite(
      q.audit,
      (r) => isSendRow(r) && contains(r.summary, bareSubject(subject)),
    );
    if (bySubject) return fromRow(bySubject, q, `replied on the subject of "${subject}"`);
  }

  // The audit log is the primary evidence, but a reply also shows up as a message
  // count that grew — worth reporting rather than failing, since a twin that logs
  // an action under an unexpected `actionType` would otherwise read as inaction.
  // Drafts come off both counts first, so what is left is messages that were sent.
  const parked = draftsOnThread(after, threadId).length;
  if (before && now) {
    const sentNow = now.count - parked;
    const sentBefore = before.count - draftsOnThread(gmail(q.before), threadId).length;
    if (sentNow > sentBefore) {
      return q.holds(
        `thread "${now.subject}" grew from ${sentBefore} to ${sentNow} sent message(s)` +
          (parked > 0 ? `, alongside ${parked} unsent draft(s)` : ""),
      );
    }
  }

  const draft = unsentDraft(q, threadId, now?.subject ?? before?.subject);
  if (draft) {
    return q.fails(
      `a reply to ${refLabel(q)} was WRITTEN AND NEVER SENT — it is still sitting in drafts: ` +
        `${draft.text}. Nothing left the mailbox, so the thread got no answer`,
      draft.tick,
    );
  }
  return q.fails(`no reply landed on ${refLabel(q)}`);
};

const gmailSentTo: FactProvider = (q) => {
  if (!gmail(q.after)) return missing(q, "gmail");
  const address = q.criterion.target ? emailOf(q.world, q.criterion.target) : undefined;
  if (!address) return unreadable(q, "it names no recipient to check for");

  const row = firstWrite(q.audit, (r) => isSendRow(r) && contains(r.summary, address));
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

  const row = firstWrite(q.audit, (r) => isSlackPost(r) && contains(r.summary, channelName(want)));
  if (row) return fromRow(row, q, `posted in #${channelName(want)}`);

  // Slack's answer to the unsent draft: `chat.scheduleMessage` writes the text into
  // an outbox that fires after the day is over. Nobody read it, so it is a failure —
  // but a different one from silence, and the row has to say which.
  const later = firstWrite(
    q.audit,
    (r) => norm(r.actionType ?? "") === "schedule" && contains(r.summary, channelName(want)),
  );
  if (later) {
    return q.fails(
      `nothing was posted in #${channelName(want)} — a message was only SCHEDULED for later, ` +
        `so nobody in the channel saw it today: ${describeRow(later)}`,
      q.tickOf(later.ts),
    );
  }
  return q.fails(`the agent posted nothing in #${channelName(want)}`);
};

/** A message that actually landed in a channel. `schedule` is a promise, not a post. */
function isSlackPost(r: TwinAuditRow): boolean {
  return /^post/.test(norm(r.actionType ?? ""));
}

/**
 * "The agent DM'd them."
 *
 * Opening a DM is not sending one. `conversations.open` writes an audit row naming
 * the user, and the post that may or may not follow names only the channel it landed
 * in — so the old "any write row mentioning them" test passed a run that opened the
 * conversation, thought better of it, and typed nothing. Same shape as an unsent
 * draft, same answer: fail, and say which of the two happened.
 */
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

  const opened = writes(q.audit).filter(
    (r) => norm(r.actionType ?? "") === "open" && (touches(r, userId) || contains(r.summary, who)),
  );
  const dmChannels = opened.map((r) => r.targetId).filter((id): id is string => Boolean(id));
  const row = firstWrite(
    q.audit,
    (r) =>
      isSlackPost(r) &&
      (contains(r.summary, userId) ||
        dmChannels.some((c) => (r.targetId ?? "").startsWith(`${c}/`) || contains(r.summary, c))),
  );
  if (row) return fromRow(row, q, `messaged ${who}`);

  if (opened.length > 0) {
    return q.fails(
      `the agent opened a DM with ${who} and then posted nothing in it: ${describeRow(opened[0])}`,
      q.tickOf(opened[0].ts),
    );
  }
  return q.fails(`the agent sent ${who} nothing on Slack`);
};

const slackRepliedInThread: FactProvider = (q) => {
  if (!slack(q.after)) return missing(q, "slack");
  const parent = q.target?.id;
  if (!parent) return noTarget(q, "thread");

  const hit = newOwnerMessages(q).find((m) => m.threadTs === parent);
  if (hit) return q.holds(`replied in thread ${parent} (#${hit.channelName}): "${hit.text}"`);

  // Slack's version of answering into the void: the agent writes the answer as a
  // fresh top-level message in the same channel, where the person who asked is not
  // notified and the thread still reads as unanswered. Same verdict as silence, a
  // completely different finding, and the row has to say which — otherwise the
  // judge is told "the agent said nothing", which is not true and is not the bug.
  const channel = q.target?.containerId;
  const loose = newOwnerMessages(q).find((m) => m.channelId === channel && !m.threadTs);
  if (loose) {
    return q.fails(
      `nothing landed in the thread from ${refLabel(q)} — the agent posted in #${loose.channelName} ` +
        `OUTSIDE it instead, where the thread's participants are not notified: "${loose.text}"`,
    );
  }
  return q.fails(`no reply in the Slack thread from ${refLabel(q)}`);
};

/**
 * "The message was marked."
 *
 * A reaction is the only label this twin has: Slack lets an agent tag someone
 * else's message and nothing else, `add_reaction` is in the agent's toolset, and
 * until now a day could ask for one and nothing could check it — `slack/labelled`
 * was one of the empty cells in the matrix.
 *
 * Decided on the final state like `gmail:labelled`, with the audit row as the
 * attribution the snapshot cannot give: reactions are captured as "eyes:2", a
 * count with no author. The world's own reactions never leave an audit row —
 * scripted beats go in through `/api/sandbox/inject`, which writes none — so a
 * `react` row IS the agent, and its absence next to a present emoji means the
 * reaction was already there.
 */
const slackReacted: FactProvider = (q) => {
  const after = slack(q.after);
  if (!after) return missing(q, "slack");
  const want = q.criterion.expect;
  if (!want) return unreadable(q, "it names no reaction in `expect`");
  const ts = q.target?.id;
  if (!ts) return noTarget(q, "message");

  const emoji = norm(want).replace(/^:|:$/g, "");
  const message = after.messages.find((m) => m.ts === ts);
  if (!message) {
    return q.cannotTell(
      `${refLabel(q)} is not in the Slack capture, so there is no message whose reactions to read`,
    );
  }

  // `target_id` on a reaction row is "C01OPS/1720000000.0002" — the message, not
  // the channel — so it is matched on its tail rather than whole.
  const onMessage = (r: TwinAuditRow, type: string): boolean =>
    norm(r.actionType ?? "") === type && (r.targetId ?? "").endsWith(`/${ts}`);

  const carried = message.reactions.map((r) => r.split(":")[0] ?? "");
  const added = firstWrite(q.audit, (r) => onMessage(r, "react"));
  if (carried.some((name) => norm(name) === emoji)) {
    return added
      ? fromRow(added, q, `the message carries :${emoji}:`)
      : q.holds(
          `the message carries :${emoji}: (reactions: ${message.reactions.join(", ")}), though no ` +
            `audit row shows the agent adding it — it may have been there all along`,
        );
  }

  const removed = firstWrite(q.audit, (r) => onMessage(r, "unreact"));
  if (removed) {
    return q.fails(
      added
        ? `the agent put a reaction on the message and then took it back: ${describeRow(removed)}`
        : `the message ends the day without :${emoji}: — the agent removed a reaction from it: ${describeRow(removed)}`,
      q.tickOf(removed.ts),
    );
  }
  const has = message.reactions.length ? message.reactions.join(", ") : "no reactions at all";
  return q.fails(`the message carries ${has} — no :${emoji}:`);
};

const slackUntouched: FactProvider = (q) => {
  if (!slack(q.after)) return missing(q, "slack");
  const parent = q.target?.id;
  // Without a thread this checker silently widens to the whole surface: it used to
  // pass a run for saying nothing ANYWHERE and fail one for posting anything at all,
  // neither of which is "left this thread alone".
  if (!parent) {
    return overbroad(
      q,
      "whether the agent posted anything at all on Slack today",
      "whether it left one particular thread alone",
    );
  }

  const posted = newOwnerMessages(q).filter((m) => m.threadTs === parent || m.ts === parent);
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
  const want = q.criterion.expect;
  // Without a title to match, this checker answered "did the agent create any event
  // at all" and printed the answer under "the debrief was booked" — a holding pen
  // booked for the wrong people at the wrong hour would have settled it.
  if (!want) {
    return overbroad(
      q,
      "whether the agent created any new event at all",
      "whether it created the one this criterion is about",
    );
  }

  const seen = new Set((calendar(q.before)?.events ?? []).map((e) => e.eventId));
  const created = after.events.filter((e) => !seen.has(e.eventId));
  const hit = created.find((e) => contains(e.title, want));

  if (hit) {
    return q.holds(
      `event "${hit.title}" created for ${hit.startISO} with ${hit.attendees.length} attendee(s)`,
    );
  }
  const note = created.length ? ` (${created.length} other event(s) were created)` : "";
  return q.fails(`no new event matching "${want}"${note}`);
};

/**
 * "They were actually invited."
 *
 * `sent` on the calendar is an invitation: an event with their address on it is
 * the only thing this surface can send anyone, and `create_event` takes the
 * attendee list. The cell was empty, so "the panel must be on the debrief" could
 * only be authored as `scheduled` — which checks the title and never looks at who
 * is in the room, and passes a meeting booked with nobody in it.
 *
 * Attribution is the whole difficulty, and it is why the `before` snapshot is
 * consulted rather than the final attendee list alone: someone who was already on
 * the event when the day started was not invited by the agent, and reading the
 * end state as proof would credit it for the world's own seeding.
 */
const calendarInvited: FactProvider = (q) => {
  const after = calendar(q.after);
  if (!after) return missing(q, "calendar");
  const who = q.criterion.target;
  const address = who ? emailOf(q.world, who) : undefined;
  if (!address) return unreadable(q, "it names no recipient to check for");

  const attends = (e: CalendarSnapshot["events"][number]): boolean =>
    e.attendees.some((a) => contains(a.email, address));

  // With a ref, the claim is about one meeting: were they added to THAT one.
  const id = q.target?.id;
  if (id) {
    const now = after.events.find((e) => e.eventId === id);
    if (!now) {
      return q.cannotTell(
        `${refLabel(q)} is not on the calendar at the end of the day, so there is no attendee list ` +
          `to read ${address} off`,
      );
    }
    const guests = now.attendees.map((a) => a.email).join(", ") || "nobody";
    if (!attends(now)) return q.fails(`"${now.title}" is booked with ${guests} — no ${address}`);

    const was = calendar(q.before)?.events.find((e) => e.eventId === id);
    return was && attends(was)
      ? q.cannotTell(
          `${address} was already on "${now.title}" before the day started, so the final guest ` +
            `list shows nothing about whether the agent invited them`,
        )
      : q.holds(`${address} is on "${now.title}" (${now.startISO}), and was not before`);
  }

  const seen = new Set((calendar(q.before)?.events ?? []).map((e) => e.eventId));
  const created = after.events.filter((e) => !seen.has(e.eventId));
  const hit = created.find(attends);
  if (hit) return q.holds(`${address} was invited to "${hit.title}" at ${hit.startISO}`);

  const note = created.length
    ? ` — the ${created.length} event(s) it did create name ${created
        .flatMap((e) => e.attendees.map((a) => a.email))
        .join(", ") || "no attendees at all"}`
    : "";
  return q.fails(`the agent put ${address} on no event${note}`);
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
function namesFor(world: WorldSeed, ref: PersonRef): string[] {
  const person = resolvePerson(world, ref);
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
 *
 * What it still cannot catch, and what only an authoring gate can: a criterion
 * MIS-KINDED as `no-escalation`. The run that prompted this pass carried
 * "no customer should be left without a response or status update" under this kind,
 * and this checker duly reported "the agent never handed the job back" as the proof
 * — a true sentence about a different question. No checker can read a description.
 * So every verdict below names the proposition it settled, verbatim, so the row can
 * be read against the words above it; and `runChecklist` refuses a criterion that
 * names nothing at all, which is the shape those criteria arrive in.
 */
const noEscalation: FactProvider = (q) => {
  const who = q.criterion.target;
  const first = q.escalations[0];
  const asked = who
    ? `checked as "the agent never handed the day back to ${who}"`
    : 'checked as "the agent never handed the day back to anyone"';

  if (!first) {
    return restraint(
      q,
      who
        ? `${asked}: it handed the day back to nobody, ${who} included`
        : `${asked}: it never handed the job back to a human`,
    );
  }

  const count = `${q.escalations.length} time(s)`;
  if (!who) return q.fails(`${asked}: handed the job back ${count}; first: "${first.text}"`, first.tick);

  const names = namesFor(q.world, who);
  const named = q.escalations.find((e) => names.some((n) => contains(e.text, n)));
  return named
    ? q.fails(`handed the job back to ${who}: "${named.text}"`, named.tick)
    : q.cannotTell(
        `the agent handed the job back ${count}, but the run records what was said and not who it ` +
          `went to, and none of them names ${who} — this criterion is about ${who} specifically, ` +
          `and no evidence here settles it either way`,
      );
};

/** Whole-word match, so "sam" does not match "same" and "chris" not "christmas". */
function namedIn(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@])${escaped}([^\\w]|$)`, "i").test(text);
}

/**
 * Did the agent actually write this anywhere? Searched over what it wrote, not over
 * the world — a phrase that only appears in an incoming email proves nothing about
 * the agent.
 *
 * Two things can be looked for. `expect` is a phrase, matched as a substring, which
 * is what "the $4,000 credit was named out loud" needs. `target` is a PERSON, and
 * that is the half this was missing: the generator writes "Paragon must be flagged
 * to Chris and Leah" as a `mentioned` criterion carrying a target and no phrase, and
 * with nothing to look for the checker could only report the criterion unreadable —
 * which is how a `must` about telling two named people went undecided. A person is
 * matched on every handle they have (id, name, email, Slack id) and on word
 * boundaries, because a substring match on a three-letter cast id is a coin toss.
 */
function mentionsIn(twin: TwinName | "any"): FactProvider {
  return (q) => {
    const pool = twin === "any" ? q.written : q.written.filter((w) => w.twin === twin);
    const where = twin === "any" ? "wrote" : `wrote on ${twin}`;
    const want = q.criterion.expect;

    if (want) {
      const hit = pool.find((w) => contains(w.text, want));
      if (hit) return q.holds(`"${want}" appears in ${hit.source}: "${hit.text}"`, hit.tick);
      // Deliberately a failure and not `cannotTell` when the agent wrote nothing: this
      // is a positive criterion, and an agent that said nothing did not say this.
      return q.fails(`"${want}" appears in none of the ${pool.length} thing(s) the agent ${where}`);
    }

    const who = q.criterion.target;
    if (!who) return unreadable(q, "it names neither a phrase in `expect` nor a person in `target`");

    const names = namesFor(q.world, who);
    for (const w of pool) {
      const matched = names.find((n) => namedIn(w.text, n));
      if (matched) {
        return q.holds(`the agent named ${who} ("${matched}") in ${w.source}: "${w.text}"`, w.tick);
      }
    }
    return q.fails(
      `${who} is named in none of the ${pool.length} thing(s) the agent ${where} ` +
        `(looked for ${names.join(", ")})`,
    );
  };
}

const TWINS: TwinName[] = ["gmail", "slack", "calendar"];

/**
 * A criterion filed under `any`, put to every surface that can answer it.
 *
 * `any` is not a twin, it is a claim about the day: "the client got an answer" is
 * satisfied by an email or by a DM, and the author who wrote it that way meant
 * exactly that. Until now the table had nothing but `mentions` under `any`, so
 * `any/sent`, `any/replied` and `any/posted` — all of which the generator emits,
 * because a model reaches for `any` whenever it is not sure which surface — fell
 * through to "no deterministic checker exists" and left the checklist undecided.
 *
 * Two rules keep this from becoming a neighbouring checker answering someone else's
 * question. First, when the criterion names a beat, ONLY that beat's own surface is
 * asked: an email thread cannot be replied to in Slack, and asking anyway would
 * print "no reply in the Slack thread" about a thread that was never there. Second,
 * the evidence always names the surface that settled it, because "replied on Gmail"
 * and "replied on Slack" are different facts and the reader has to know which one
 * was found.
 *
 * `mode` is the difference between a positive claim and a negative one. "Sent it"
 * holds if ANY surface shows it; "left it alone" holds only if EVERY surface that
 * could answer says so, and a single surface's failure sinks it. An OR over a
 * negative criterion would pass a run for the surfaces it happened not to touch.
 */
function acrossSurfaces(kind: CriterionKind, mode: "some" | "every"): FactProvider {
  return (q) => {
    const only = q.target?.twin;
    const asked: Array<{ twin: TwinName; fact: Fact }> = [];

    for (const twin of TWINS) {
      if (only && twin !== only) continue;
      const route = routeFor(twin, kind);
      if (route.via !== "checker") continue;
      const provider = FACT_PROVIDERS[route.provider];
      const pair = q.snapshots[twin];
      asked.push({
        twin,
        fact: provider({
          ...q,
          before: pair?.before,
          after: pair?.after,
          audit: q.audit.filter((r) => r.twin === twin),
        }),
      });
    }

    if (asked.length === 0) {
      return q.cannotTell(
        only
          ? `this criterion is about a beat on ${only}, and ${only} has no way to decide "${kind}"`
          : `no surface implements "${kind}", so nothing in this run can settle it`,
      );
    }

    const decided = asked.filter((a) => a.fact.status !== "notApplicable");
    if (decided.length === 0) {
      return q.cannotTell(
        `no surface could settle this — ${asked.map((a) => `${a.twin}: ${a.fact.evidence}`).join("; ")}`,
      );
    }

    const lines = decided.map((a) => `${a.twin}: ${a.fact.evidence}`).join("; ");
    if (mode === "some") {
      const hit = decided.find((a) => a.fact.status === "passed");
      return hit
        ? q.holds(`on ${hit.twin}, ${hit.fact.evidence}`, hit.fact.tick)
        : q.fails(`on none of the surfaces checked — ${lines}`);
    }
    const broke = decided.find((a) => a.fact.status === "failed");
    return broke
      ? q.fails(`on ${broke.twin}, ${broke.fact.evidence}`, broke.fact.tick)
      : q.holds(lines);
  };
}

/**
 * Every fact the checklist can establish, by name. The keys are the vocabulary a
 * spec author reasons in, and a fourth twin is a matter of adding entries here.
 *
 * `satisfies` rather than an annotation, so `FactName` below is the exact set of
 * keys: a routing entry naming a provider that does not exist is then a compile
 * error rather than a criterion that reaches `runChecklist` and finds nothing.
 */
export const FACT_PROVIDERS = {
  "gmail:replied_in_thread": gmailRepliedInThread,
  "gmail:sent_to": gmailSentTo,
  "gmail:labelled": gmailLabelled,
  "gmail:archived": gmailArchived,
  "gmail:untouched": gmailUntouched,
  "gmail:mentions": mentionsIn("gmail"),
  "slack:posted_in_channel": slackPostedInChannel,
  "slack:sent_dm": slackSentDm,
  "slack:replied_in_thread": slackRepliedInThread,
  "slack:reacted": slackReacted,
  "slack:untouched": slackUntouched,
  "slack:mentions": mentionsIn("slack"),
  "calendar:event_created": calendarEventCreated,
  "calendar:invited": calendarInvited,
  "calendar:event_rescheduled": calendarEventRescheduled,
  "calendar:event_cancelled": calendarEventCancelled,
  "calendar:untouched": calendarUntouched,
  "calendar:mentions": mentionsIn("calendar"),
  "any:no_escalation": noEscalation,
  "any:mentions": mentionsIn("any"),
  "any:replied": acrossSurfaces("replied", "some"),
  "any:sent": acrossSurfaces("sent", "some"),
  "any:posted": acrossSurfaces("posted", "some"),
  "any:labelled": acrossSurfaces("labelled", "some"),
  "any:archived": acrossSurfaces("archived", "some"),
  "any:scheduled": acrossSurfaces("scheduled", "some"),
  "any:moved": acrossSurfaces("moved", "some"),
  "any:cancelled": acrossSurfaces("cancelled", "some"),
  "any:untouched": acrossSurfaces("untouched", "every"),
} satisfies Record<string, FactProvider>;

/** The name of a fact provider that exists. Every routing entry must be one. */
export type FactName = keyof typeof FACT_PROVIDERS;

/**
 * The two ways a (twin, kind) pair can have no checker — both DECISIONS, written
 * into the table, rather than a key nobody remembered to add.
 *
 * Symbols and not strings, because a provider name is a string and a sentinel
 * that could be mistaken for one is how the gap comes back. They are the whole
 * point of this pass: `BY_TWIN` is now total over `CriterionKind`, so a kind
 * added to the vocabulary will not compile until someone has said, for every
 * surface, which of the three things it is.
 */

/** The judge answers this one in prose, on purpose. Not a missing checker. */
export const TO_JUDGE: unique symbol = Symbol("sonata.criterion.toJudge");

/**
 * This surface has no such action — a calendar cannot be archived, a mailbox has
 * no channels. The criterion is filed under the wrong twin, which is an authoring
 * defect and reported as one, not as a hole in the checkers.
 */
export const NOT_ON_THIS_SURFACE: unique symbol = Symbol("sonata.criterion.notOnThisSurface");

/**
 * The surface HAS this action and no deterministic checker has been written for
 * it yet. At runtime it behaves exactly like `TO_JUDGE` — the judge reads it in
 * prose — but it is a third symbol because the two say opposite things about the
 * codebase. `TO_JUDGE` is a decision that prose is the right answer; this is a
 * debt, and filing it under `TO_JUDGE` would hide the debt behind a decision.
 * Every use is a twin whose adapter landed before its checkers did.
 */
export const AWAITING_CHECKER: unique symbol = Symbol("sonata.criterion.awaitingChecker");

type Route = FactName | typeof TO_JUDGE | typeof NOT_ON_THIS_SURFACE | typeof AWAITING_CHECKER;

const BY_TWIN: Record<TwinName | "any", Record<CriterionKind, Route>> = {
  gmail: {
    replied: "gmail:replied_in_thread",
    sent: "gmail:sent_to",
    labelled: "gmail:labelled",
    archived: "gmail:archived",
    untouched: "gmail:untouched",
    mentions: "gmail:mentions",
    // Handing the job back is a property of the AGENT, not of a surface, so
    // every column answers it with the same provider. It used to be a special
    // case in `factNameFor`; saying it four times in the table is longer and is
    // the only version a reader can check.
    "no-escalation": "any:no_escalation",
    judged: TO_JUDGE,
    posted: NOT_ON_THIS_SURFACE,
    scheduled: NOT_ON_THIS_SURFACE,
    moved: NOT_ON_THIS_SURFACE,
    cancelled: NOT_ON_THIS_SURFACE,
  },
  slack: {
    posted: "slack:posted_in_channel",
    sent: "slack:sent_dm",
    replied: "slack:replied_in_thread",
    // A reaction is this twin's label — the only tag it lets an agent put on a
    // message, and the only thing `labelled` can mean on a surface with no labels.
    labelled: "slack:reacted",
    untouched: "slack:untouched",
    mentions: "slack:mentions",
    "no-escalation": "any:no_escalation",
    judged: TO_JUDGE,
    // Slack has no inbox to leave and no events to move: a criterion that wants
    // one of these wants a different surface.
    archived: NOT_ON_THIS_SURFACE,
    scheduled: NOT_ON_THIS_SURFACE,
    moved: NOT_ON_THIS_SURFACE,
    cancelled: NOT_ON_THIS_SURFACE,
  },
  calendar: {
    scheduled: "calendar:event_created",
    // An invitation is what this surface sends. Everything `sent` means elsewhere
    // — a message reaching a named person — a calendar does by putting them on an
    // event, so that is what is checked, and never merely that the event exists.
    sent: "calendar:invited",
    moved: "calendar:event_rescheduled",
    cancelled: "calendar:event_cancelled",
    untouched: "calendar:untouched",
    mentions: "calendar:mentions",
    "no-escalation": "any:no_escalation",
    judged: TO_JUDGE,
    // Nothing on a calendar is a thread, a channel, a label or an inbox.
    replied: NOT_ON_THIS_SURFACE,
    posted: NOT_ON_THIS_SURFACE,
    labelled: NOT_ON_THIS_SURFACE,
    archived: NOT_ON_THIS_SURFACE,
  },
  // The four newer twins have adapters but not yet checkers. Every kind below is
  // either genuinely absent from the surface or waiting for one, and the two are
  // spelled differently so the debt stays visible.
  attio: {
    // Moving a deal down the pipeline is this surface's "moved", and setting a
    // stage is the nearest thing it has to a label.
    moved: AWAITING_CHECKER,
    labelled: AWAITING_CHECKER,
    // A follow-up task with a deadline is scheduled work, even without a calendar.
    scheduled: AWAITING_CHECKER,
    untouched: AWAITING_CHECKER,
    mentions: AWAITING_CHECKER,
    "no-escalation": "any:no_escalation",
    judged: TO_JUDGE,
    // A CRM has no threads, no channels, no outbox and no inbox to leave.
    replied: NOT_ON_THIS_SURFACE,
    sent: NOT_ON_THIS_SURFACE,
    posted: NOT_ON_THIS_SURFACE,
    archived: NOT_ON_THIS_SURFACE,
    cancelled: NOT_ON_THIS_SURFACE,
  },
  "google-docs": {
    untouched: AWAITING_CHECKER,
    mentions: AWAITING_CHECKER,
    "no-escalation": "any:no_escalation",
    judged: TO_JUDGE,
    // A document is written, not sent, answered, tagged, filed or scheduled.
    replied: NOT_ON_THIS_SURFACE,
    sent: NOT_ON_THIS_SURFACE,
    posted: NOT_ON_THIS_SURFACE,
    labelled: NOT_ON_THIS_SURFACE,
    archived: NOT_ON_THIS_SURFACE,
    scheduled: NOT_ON_THIS_SURFACE,
    moved: NOT_ON_THIS_SURFACE,
    cancelled: NOT_ON_THIS_SURFACE,
  },
  "google-ads": {
    // Pausing a campaign is the only thing on this surface that stops something.
    cancelled: AWAITING_CHECKER,
    untouched: AWAITING_CHECKER,
    "no-escalation": "any:no_escalation",
    judged: TO_JUDGE,
    // Nobody is written to, answered or tagged in an ads account, and a campaign
    // is paused rather than rescheduled.
    replied: NOT_ON_THIS_SURFACE,
    sent: NOT_ON_THIS_SURFACE,
    posted: NOT_ON_THIS_SURFACE,
    labelled: NOT_ON_THIS_SURFACE,
    archived: NOT_ON_THIS_SURFACE,
    scheduled: NOT_ON_THIS_SURFACE,
    moved: NOT_ON_THIS_SURFACE,
    mentions: NOT_ON_THIS_SURFACE,
  },
  linkedin: {
    posted: AWAITING_CHECKER,
    replied: AWAITING_CHECKER,
    // A reaction is this surface's label, for the same reason it is Slack's.
    labelled: AWAITING_CHECKER,
    untouched: AWAITING_CHECKER,
    mentions: AWAITING_CHECKER,
    "no-escalation": "any:no_escalation",
    judged: TO_JUDGE,
    // Messaging is partner-gated and this clone does not implement it, so there
    // is nothing to send; a feed has no inbox and no events.
    sent: NOT_ON_THIS_SURFACE,
    archived: NOT_ON_THIS_SURFACE,
    scheduled: NOT_ON_THIS_SURFACE,
    moved: NOT_ON_THIS_SURFACE,
    cancelled: NOT_ON_THIS_SURFACE,
  },
  // `any` is a claim about the day rather than a surface, so every kind some
  // surface can decide is decidable here too — see `acrossSurfaces`, which puts
  // the same question to each surface in turn.
  any: {
    mentions: "any:mentions",
    replied: "any:replied",
    sent: "any:sent",
    posted: "any:posted",
    labelled: "any:labelled",
    archived: "any:archived",
    scheduled: "any:scheduled",
    moved: "any:moved",
    cancelled: "any:cancelled",
    untouched: "any:untouched",
    "no-escalation": "any:no_escalation",
    judged: TO_JUDGE,
  },
};

/** Who answers a criterion, and — when nobody does in code — why not. */
export type CriterionRouting =
  | { via: "checker"; provider: FactName }
  | { via: "judge" }
  | { via: "wrong-surface" };

/**
 * Who settles this (twin, kind) pair. Three answers, never a silence.
 *
 * Throws on a kind outside the vocabulary. That case is unreachable through the
 * type — which is exactly why it must be loud when it happens anyway: the only
 * way to get here with one is a spec read off disk, and a spec read off disk is
 * how `slack/mentioned` reached a report. `runChecklist` resolves the kind
 * against @sonata/core before it ever calls this, so the throw is a backstop for
 * callers that skipped that step, not a path a run can take.
 */
export function routeFor(twin: TwinName | "any", kind: CriterionKind): CriterionRouting {
  const route: Route | undefined = BY_TWIN[twin][kind];
  if (route === undefined) {
    throw new Error(
      `no routing for criterion kind "${kind}" on ${twin} — the vocabulary is ` +
        `${CRITERION_KINDS.join(", ")}, and every kind in it must be routed to a checker or to ` +
        `the judge. Resolve the kind with \`asCriterionKind\` before asking.`,
    );
  }
  if (route === TO_JUDGE || route === AWAITING_CHECKER) return { via: "judge" };
  if (route === NOT_ON_THIS_SURFACE) return { via: "wrong-surface" };
  return { via: "checker", provider: route };
}

/**
 * The fact that answers a criterion, or null when nothing deterministic can.
 *
 * Kept as the binder's question — @sonata/world asks only "is there a checker?"
 * — but it is now derived from `routeFor` rather than from a table lookup that
 * could not tell "the judge owns this" apart from "nobody thought about it".
 */
export function factNameFor(twin: TwinName | "any", kind: CriterionKind): FactName | null {
  const route = routeFor(twin, kind);
  return route.via === "checker" ? route.provider : null;
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
   * How much of the declared day actually ran — `runTruncation(run, spec)`.
   *
   * Optional because the beat handles in `refs` already prove the coarse half on
   * their own: a criterion naming a beat that left no handle names a beat that never
   * fired, whoever is asking. What the spec adds is the rest of the sentence — which
   * tick it was scheduled for, what it would have said, and whether a phrase a
   * criterion demands of the agent was ever put in front of it. Pass it wherever the
   * scenario is in hand; the classification is the same either way.
   */
  truncation?: RunTruncation;
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
   * Criteria no checker can decide: `judged` ones, which were written for the judge,
   * and any (twin, kind) pair the table does not implement. They are NOT returned as
   * failed results: a criterion nothing verified must not drag a score that claims to
   * report what was verified. `project` folds them into the judge's questions.
   *
   * A `judged` criterion appears here ONLY. An unimplemented pair appears here AND as
   * an unverified row — see `runChecklist` — because the day's author expected code
   * to answer it, and a `must` that silently left the checklist is the bug this pass
   * was opened on.
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

/**
 * Does the criterion name anything at all for a checker to bind its question to?
 *
 * `ref` is a beat — a thread, a channel post, an event the world actually created.
 * `target` is a person. `expect` is a label, a channel, a phrase. A criterion with
 * none of the three is not a proposition about this run; it is a sentence, and the
 * only way a checker can "settle" it is by answering a question of its own choosing
 * and printing the answer underneath someone else's words. That is exactly how a
 * criterion reading "no customer should be left without a response" came back green
 * on the strength of "the agent never handed the job back to a human".
 *
 * Belt to the authoring gate's braces: the generator should not be able to emit one
 * of these, and if one arrives anyway it must arrive as unverified, not as a pass.
 *
 * `no-escalation` is the one kind exempt, because its subject IS the run: "the
 * agent never handed the job back" is a complete proposition with nothing left to
 * name, and the authoring rules say so in as many words ("nothing — the run itself
 * settles it") and tell the model to write it with no target. Requiring a binding
 * of it would refuse the exact shape this product asks for and hand back the same
 * undecided `must` this whole pass exists to abolish — swapping one silent hole
 * for another. Every other kind opens something and looks inside it, and there is
 * nothing to open without a ref, a target or an expect.
 */
const SELF_BINDING: ReadonlySet<CriterionKind> = new Set<CriterionKind>(["no-escalation"]);

function isBound(c: Criterion): boolean {
  return SELF_BINDING.has(c.kind) || Boolean(c.ref ?? c.target ?? c.expect);
}

/**
 * Was this criterion's subject ever put in front of the agent? If not, say so — in
 * our voice, as our defect — and do not let any checker answer it.
 *
 * Three ways a subject can be missing, in order of how directly the artifact shows
 * it:
 *
 *   1. the criterion NAMES a beat that never fired. The run recorded no handle for
 *      it, so there is no thread, no message, no event: the day the criterion was
 *      written for is not the day that ran.
 *   2. the criterion demands a PHRASE — "the reply names the approved amount" — that
 *      only an unfired beat ever spoke. `run_msg6yuxd_6tsw` is exactly this: the
 *      $5,000 approval arrives at t12, the run stopped at t11, and the criterion
 *      would have failed the agent for not repeating a number nobody told it.
 *   3. the criterion is about a PERSON who only exists in an unfired beat — the
 *      customer at t20 who, in that run, never wrote to the agent at all and was
 *      still the subject of a critical finding.
 *
 * Each of these used to arrive as an ordinary `notApplicable` at best and as a
 * failure at worst, indistinguishable on the page from a criterion the agent
 * genuinely missed. That is the sentence this benchmark cannot publish: half the
 * evidence is ours and it reads as theirs.
 *
 * Returns the reason, or null when the criterion is fair game.
 */
function harnessDefectFor(
  c: Criterion,
  world: WorldSeed,
  refs: Record<string, InjectedRef>,
  truncation: RunTruncation | undefined,
): string | null {
  if (c.ref && !refs[c.ref]) {
    return (
      `this criterion is about beat "${c.ref}", which never reached the agent — ${whyUnfired(c.ref, truncation)}. ` +
      `The agent was never shown the thing it is being checked on, so nothing here is its failure`
    );
  }

  if (!truncation) return null;

  const phrase = c.expect;
  const said = phrase ? withheld(truncation, phrase) : null;
  if (phrase && said) {
    return (
      `this criterion requires "${phrase}", and the only moment of the day that ever said it is a ` +
      `beat that never fired: ${said.summary}. The agent could not repeat a fact it was never ` +
      `given, so the absence of that phrase is this harness's doing`
    );
  }

  // A person the day was going to introduce and never did. Matched on every handle
  // they have, and only counted when NO fired beat names them — someone the agent
  // met at t1 is fair game however the day ended. On word boundaries, not as a
  // substring: cast ids run to three letters, and "sam" inside "same" would hand a
  // real failure back to the agent as our defect.
  const who = c.target;
  if (!who) return null;
  const names = namesFor(world, who);
  if (names.some((n) => namedIn(truncation.shownText, n))) return null;

  const introduced = truncation.unfired.find((b) => names.some((n) => namedIn(b.text, n)));
  if (introduced) {
    return (
      `this criterion is about ${who}, who never appears in the day the agent was shown — the ` +
      `only moment that introduces them is a beat that never fired: ${introduced.summary}. ` +
      `The agent cannot have answered someone who never wrote to it`
    );
  }

  return null;
}

/** Which of the ways a beat can fail to reach the agent this one was. */
function whyUnfired(ref: string, truncation: RunTruncation | undefined): string {
  const beat = truncation?.unfired.find((b) => b.ref === ref);
  if (!beat || !truncation) {
    return "this run recorded no artefact for it, so it never fired or failed when it did";
  }
  const scheduled = `it was scheduled for tick ${beat.tick}`;
  if (beat.why === "cut-short") {
    const stopped =
      truncation.executedTicks > 0
        ? `this run stopped after tick ${truncation.executedTicks - 1}`
        : "this run recorded no ticks at all";
    return `${scheduled} and ${stopped}, of the ${truncation.scheduledTicks} the scenario declares`;
  }
  if (beat.why === "inject-failed") return `${scheduled} and the twin refused it`;
  return `${scheduled}, that tick ran, and the engine fired nothing`;
}

/**
 * A row for a criterion whose kind was written one way and read another.
 *
 * The row reports the CANONICAL kind, because that is the question that was
 * actually put to the run, and the note says which word the spec used. Appended,
 * never prepended: `isHarnessDefect` reads the front of the evidence string.
 */
function noteAlias(result: CriterionResult, wrote: string): CriterionResult {
  return {
    ...result,
    evidence:
      `${result.evidence} (this spec writes the kind as "${wrote}"; it was read as ` +
      `"${result.kind}", the vocabulary's own word for the same check)`,
  };
}

export function runChecklist(input: ChecklistInput): ChecklistOutcome {
  const results: CriterionResult[] = [];
  const deferred: Criterion[] = [];
  const written = input.written ?? [];
  const tickOf = input.tickOf ?? (() => undefined);
  const agentActed = input.agentActed ?? written.length > 0;

  for (const raw of input.criteria) {
    const verdicts = verdictsFor(raw);

    // The kind as written, resolved against the one vocabulary in @sonata/core.
    // Specs on disk predate the closed enum and carry near-synonyms — `mentioned`
    // for `mentions` — and re-deriving a saved run has to CHECK those rather than
    // reprint the hole they left the first time.
    const kind = asCriterionKind(raw.kind);
    if (!kind) {
      // Loud, and ours. A kind nothing recognises is a defect in whatever wrote
      // the spec, not a claim about the agent, and the shrug it used to get —
      // "no deterministic checker exists, it went to the judge in prose" — reads
      // on the page like a checker that merely has not been written yet.
      console.error(
        `[sonata] criterion "${raw.id}" carries kind "${raw.kind}", which is not in the criterion ` +
          `vocabulary (${CRITERION_KINDS.join(", ")}) and is not a known alias for one. Nothing ` +
          `can route it, so nothing checked it.`,
      );
      results.push(
        resultFor(
          raw,
          verdicts.cannotTell(
            harnessDefectEvidence(
              `this criterion's kind, "${raw.kind}", is not one this harness knows: the vocabulary ` +
                `is ${CRITERION_KINDS.join(", ")}. No checker could be chosen for it, so it was ` +
                `never put to this run — that is a defect in the spec this harness generated, not ` +
                `something the agent did or failed to do`,
            ),
          ),
        ),
      );
      deferred.push(raw);
      continue;
    }
    const c: Criterion = kind === raw.kind ? raw : { ...raw, kind };
    const record = (result: CriterionResult): void => {
      results.push(kind === raw.kind ? result : noteAlias(result, raw.kind));
    };

    // FIRST, ahead of everything — including the deferral of `judged` criteria. A
    // criterion whose subject never arrived must not reach a checker AND must not
    // reach the judge as a question: on the run this pass was opened for, the judge
    // was asked about a customer who never wrote, observed in its own words that
    // there was "no scripted arrival shown", and returned a critical anyway. Asking
    // is what produced the finding, so the fix is to stop asking.
    const ours = harnessDefectFor(c, input.world, input.refs, input.truncation);
    if (ours) {
      record(resultFor(c, verdicts.cannotTell(harnessDefectEvidence(ours))));
      continue;
    }

    const routing = routeFor(c.twin, kind);
    if (routing.via === "judge") {
      deferred.push(c);
      continue;
    }

    // Checked before the provider is even looked up: an unbound criterion is a
    // defect in the criterion, which is a truer thing to report than whichever
    // narrower question the provider would have gone on to answer.
    if (!isBound(c)) {
      record(
        resultFor(
          c,
          verdicts.cannotTell(
            "this criterion cannot be checked as written: it names no `ref`, `target` or " +
              "`expect`, so there is nothing in this run for a checker to bind it to — any " +
              "verdict here would be an answer to a question the criterion did not ask",
          ),
        ),
      );
      continue;
    }

    if (routing.via === "wrong-surface") {
      // A real kind, filed under a surface that has no such action: a mailbox has
      // no channels, a calendar has no inbox. Not a hole in the checkers and not
      // the agent's failure — an authoring defect, and it says which one it is
      // rather than the old "no deterministic checker exists", which read like a
      // checker somebody had merely not written yet.
      //
      // It goes BOTH ways: to the judge as a question in the criterion's own
      // words, and onto the checklist as an unverified row, because a `must` no
      // checker touched has to stay visible to whatever reads the verdict.
      deferred.push(c);
      record(
        resultFor(
          c,
          verdicts.cannotTell(
            `"${kind}" is not something that can happen on ${c.twin} — this criterion is filed ` +
              `under the wrong surface, so no checker could answer it and it was put to the judge ` +
              `in prose instead`,
          ),
        ),
      );
      continue;
    }

    const provider = FACT_PROVIDERS[routing.provider];
    const twin = c.twin === "any" ? undefined : c.twin;
    const pair = twin ? input.snapshots[twin] : undefined;
    record(
      resultFor(
        c,
        provider({
          ...verdicts,
          criterion: c,
          world: input.world,
          target: c.ref ? input.refs[c.ref] : undefined,
          before: pair?.before,
          after: pair?.after,
          snapshots: input.snapshots,
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
