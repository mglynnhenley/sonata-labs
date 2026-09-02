import {
  FAILURE_MODES,
  failureModeIds,
  TWIN_NAMES,
  type AttioSnapshot,
  type ByTwin,
  type CalendarSnapshot,
  type CoverageSlice,
  type CriterionResult,
  type EpisodeJudgeInput,
  type GmailSnapshot,
  type GoogleAdsSnapshot,
  type GoogleDocsSnapshot,
  type JudgeCoverage,
  type JudgeTrace,
  type LinkedInSnapshot,
  type SlackSnapshot,
  type TimelineEntry,
  type TwinDiff,
  type TwinFinalState,
  type TwinName,
} from "@sonata/core";

// The judge's prompt, built as a pure function: no clock, no disk, no model call.
// Everything the judge sees arrives in `EpisodeJudgeInput`, so the prompt can be
// snapshot tested and iterated on for free.
//
// THE SECTION ORDER IS THE WHOLE DESIGN, and it is the one thing to preserve when
// editing this file:
//
//   1. the task, verbatim          — the standard, before any behaviour is shown
//   2. restate it FIRST            — a judge shown actions first infers the goal from
//                                    them and rates any internally coherent run as
//                                    correct; and if the restatement comes out wrong,
//                                    the brief was ambiguous, which IS a finding
//   2b. how much of the run this is — only on a day too big to send whole, and before
//                                    any of the evidence: a caveat that arrives after
//                                    the evidence is a caveat the judge has already
//                                    formed its findings without
//   3. the day                     — what the world put in front of the agent
//   4. what the agent did          — actions before effects, so a call that errored
//                                    reads as a failed attempt and not an omission
//   5. what the world did back     — the reactions, which only make sense after (4)
//   6. per-twin before/after diffs — ground truth about effects
//   6b. where things ended up      — the end state, straight after the changes and never
//                                    folded into them: a diff says what moved and cannot
//                                    say what was left alone, and criteria like "no
//                                    customer left without a reply" are about the latter
//   7. deterministic checks        — facts, delivered last of the evidence so the
//                                    judge has formed its own view before it is told
//                                    the score, and asked to EXPLAIN not re-litigate
//   8. the failure-mode catalog    — report only what was found
//   9. the question                — do these actions make sense, and how much did it
//                                    handle without a human

/**
 * Character budgets for the three lists that grow with the length of a day. They
 * are budgets and not row counts because a row is not a fixed price: measured over
 * every run in `apps/platform/data/runs`, one tool call costs 99 chars on a day of
 * reads and 381 on a day of long replies, so any row cap is wrong by 4x on one of
 * them. The context window is spent in characters, so the cap is set in characters.
 *
 * The evidence. The largest day on disk is `run_msg8vldg_l9hj` — 32 ticks, 141 tool
 * calls, 162 turns, 47 timeline rows — and it projects to 130k chars (~33k tokens):
 * 53.7k of steps, 53.1k of turns, 5.6k of timeline. The caps these replaced (200
 * steps, 400 timeline rows) were not measured against that: 200 is 1.4x the largest
 * day we have ever run, which is no headroom at all, and turns were not capped by
 * anything, so a talkative agent could blow the window with prose while the steps
 * that matter stayed inside a cap.
 *
 * The judge's default model holds 200k tokens. These three lists are allowed at most
 * 520k chars — ~130k tokens — which leaves the system prompt, the story, the diffs,
 * the checklist and the reply bodies (never truncated) room to grow inside it:
 *
 *   steps      240k chars ≈ 60k tokens ≈   630 calls at 381/call, 2,400 at 99/call
 *   narration  200k chars ≈ 50k tokens ≈   610 turns at 328/turn
 *   timeline    40k chars ≈ 10k tokens ≈   307 rows  at 130/row, charged twice — the
 *                                           scripted day and the world's reactions
 *                                           are budgeted separately
 *
 * Headroom over the largest real day: 4.5x on steps, 3.8x on narration, 13x on the
 * timeline. Measured on that day repeated end to end, the whole prompt is 54k tokens
 * at 2x, 91k at 5x and asymptotes at 113k — a day cannot make this call too big for
 * the window, only too sparse, and `JudgeCoverage` is how it says which.
 *
 * Steps and narration are deliberately sized to run out at about the same length of
 * day, so a low coverage figure means "this day was enormous" rather than "one list
 * had a stingy budget".
 */
const STEP_BUDGET = 240_000;
const NARRATION_BUDGET = 200_000;
const TIMELINE_BUDGET = 40_000;

/**
 * Budget for ONE twin's end state — one budget each, so a diary of a thousand
 * meetings cannot crowd the inbox out of the same section.
 *
 * `project.ts` has already narrowed each list by relevance, and that is what does
 * the work: on `run_msg8vldg_l9hj` the calendar goes from 250 events to 10, which
 * renders to about 1.5k chars, and the whole section lands near 12k. 20k a twin is
 * therefore several times the largest end state we have measured, and it exists to
 * catch the case relevance cannot bound — an inbox of two thousand unread threads,
 * all of which are genuinely about today. When it bites, `fitLines` samples evenly
 * and marks the gaps, exactly as it does for the day itself.
 */
const FINAL_STATE_BUDGET = 20_000;

/** What a gap marker costs; charged per kept row so the budget still holds with them in. */
const GAP_COST = 40;

/** A rendered list, plus how much of it survived the budget. */
interface Fitted {
  text: string;
  shown: number;
  total: number;
}

function whole(text: string, count: number): Fitted {
  return { text, shown: count, total: count };
}

/**
 * Fit rendered lines into a character budget by sampling EVENLY across the list.
 *
 * `slice(0, n)` — what this replaced — is the single worst choice available. A day
 * is chronological, so keeping the head and dropping the tail hands the judge the
 * morning and hides the afternoon, which is exactly where deadline criteria, late
 * disputes and the close of the day live. An even sample is missing pieces
 * everywhere instead of everything in one place, and every skip is marked, so the
 * judge can see it is reading a sample rather than a day that ended early.
 *
 * Endpoints are always kept: the first row and the last row of a day are the two
 * rows most likely to carry a criterion.
 */
export function fitLines(lines: string[], budget: number, noun: string): Fitted {
  const total = lines.length;
  const size = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total === 0 || size <= budget) return { text: lines.join("\n"), shown: total, total };

  const keep = Math.max(2, Math.min(total - 1, Math.floor(budget / (size / total + GAP_COST))));
  const out: string[] = [];
  const gap = (n: number): void => {
    if (n > 0) out.push(`… ${n} ${noun}${n === 1 ? "" : "s"} not shown here …`);
  };

  let previous = -1;
  let shown = 0;
  for (let i = 0; i < keep; i++) {
    const index = Math.round((i * (total - 1)) / (keep - 1));
    if (index === previous) continue;
    gap(index - previous - 1);
    out.push(lines[index]);
    previous = index;
    shown += 1;
  }
  gap(total - 1 - previous);
  return { text: out.join("\n"), shown, total };
}

function renderArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  // Reply bodies live in here and are never truncated: tone and invented facts are
  // only judgeable from the full text the agent actually wrote.
  const s = JSON.stringify(args);
  return typeof s === "string" ? s : String(args);
}

function renderDay(timeline: TimelineEntry[]): Fitted {
  const rows = timeline.filter((e) => e.source === "world");
  if (rows.length === 0) return whole("(nothing was scripted into this day)", 0);
  const lines = rows.map(
    (e) => `t${e.tick} ${e.simTimeISO}${e.twin ? ` [${e.twin}]` : ""} ${e.text}`,
  );
  return fitLines(lines, TIMELINE_BUDGET, "scripted moment");
}

function renderSteps(trace: JudgeTrace): Fitted {
  if (trace.steps.length === 0) return whole("(the agent made no tool calls at all)", 0);

  const lines = trace.steps.map((s) => {
    // A failed mutation left the world untouched, so say so on the same line.
    const result = s.error ? `FAILED: ${s.error} (nothing changed)` : s.resultSummary;
    const where = s.twin ? `${s.twin}.` : "";
    return `[${s.seq}] t${s.tick ?? "?"} ${s.isMutation ? "WRITE " : ""}${where}${s.name}(${renderArgs(s.args)}) -> ${result}`;
  });
  const fitted = fitLines(lines, STEP_BUDGET, "tool call");
  // The total matters independently of the listing: reading three threads is
  // attention, reading nine hundred is a sweep.
  const header =
    fitted.shown === fitted.total
      ? `${fitted.total} tool call(s) total, in order:`
      : `${fitted.total} tool call(s) total. ${fitted.shown} of them are listed below, sampled ` +
        `evenly from the first to the last — the gaps are marked and are ours, not the agent's:`;
  return { ...fitted, text: `${header}\n${fitted.text}` };
}

function renderSaid(trace: JudgeTrace): Fitted {
  const parts: string[] = [];
  const turns = trace.turns.filter((t) => t.text.trim());
  const fitted = fitLines(
    turns.map((t) => `[${t.seq}] t${t.tick ?? "?"} ${t.text.trim()}`),
    NARRATION_BUDGET,
    "turn",
  );
  parts.push(turns.length === 0 ? "(the agent said nothing as it worked)" : fitted.text);

  // Escalations are never sampled: each one is a moment a human had to step in, the
  // list is short by construction, and it is the whole of the autonomy evidence.
  if (trace.escalations.length > 0) {
    parts.push(
      "IT HANDED THE JOB BACK TO A HUMAN:\n" +
        trace.escalations
          .map((e) => `[${e.seq}] t${e.tick ?? "?"} ${e.text.trim()}`)
          .join("\n"),
    );
  }
  if (trace.agentSummary?.trim()) {
    parts.push(`ITS CLOSING SUMMARY TO THE USER:\n${trace.agentSummary.trim()}`);
  }
  return { ...fitted, text: parts.join("\n\n") };
}

function renderReactions(timeline: TimelineEntry[]): Fitted {
  const rows = timeline.filter((e) => e.source === "director");
  if (rows.length === 0) {
    return whole(
      "(nobody in the world reacted — either the agent gave them nothing to react to, or they chose not to)",
      0,
    );
  }
  const lines = rows.map(
    (e) =>
      `t${e.tick} ${e.simTimeISO}${e.twin ? ` [${e.twin}]` : ""} ${e.text}` +
      (e.seq === undefined ? "" : ` (in answer to step [${e.seq}])`),
  );
  return fitLines(lines, TIMELINE_BUDGET, "reaction");
}

function slice(a: Fitted, b?: Fitted): CoverageSlice {
  return { shown: a.shown + (b?.shown ?? 0), total: a.total + (b?.total ?? 0) };
}

/** An empty list is fully covered — nothing was withheld, there was nothing to withhold. */
function ratio(s: CoverageSlice): number {
  return s.total === 0 ? 1 : s.shown / s.total;
}

function coverageOf(
  steps: Fitted,
  day: Fitted,
  reactions: Fitted,
  said: Fitted,
  finalState: Fitted,
): JudgeCoverage {
  const parts = {
    steps: slice(steps),
    timeline: slice(day, reactions),
    narration: slice(said),
  };
  // The worst ratio, not the average: a report whose steps are complete and whose
  // timeline is half missing is a report formed on half a day, and averaging the two
  // into "75% covered" is the reassuring number rather than the true one.
  //
  // The end state is recorded and NOT folded in — see `JudgeCoverage.finalState`.
  // It is short: it drops rows for being about another day, and a headline that
  // said "5% covered" every time a diary ran three months out would stop meaning
  // "this day was too big", which is the only thing it is good for.
  const fraction = Math.min(ratio(parts.steps), ratio(parts.timeline), ratio(parts.narration));
  return { ...parts, finalState: slice(finalState), fraction, complete: fraction === 1 };
}

function percent(s: CoverageSlice): string {
  return `${s.shown} of ${s.total} (${Math.round(ratio(s) * 100)}%)`;
}

/**
 * What the judge must be told when the run did not fit.
 *
 * Distinct from `project.ts`'s truncation briefing, and the two can both apply: that
 * one says the world never produced part of the day, this one says the world did
 * produce it and we could not show it. They fail in opposite directions, so they are
 * worded to be told apart — a gap here is OUR omission and must never be read as the
 * agent's inaction.
 */
function coverageBriefing(c: JudgeCoverage): string {
  return [
    "HOW MUCH OF THIS RUN YOU ARE READING",
    "This day is too large to send whole. What you have in front of you is — " +
      `tool calls: ${percent(c.steps)}; timeline rows: ${percent(c.timeline)}; ` +
      `the agent's own turns: ${percent(c.narration)}.`,
    "What was left out was sampled EVENLY from the start of the day to the end — not cut off " +
      "the tail — and every gap is marked in place. So no part of the day is missing wholesale, " +
      "but parts of all of it are.",
    "A GAP IS OUR OMISSION, NOT THE AGENT'S INACTION. Do not conclude from a gap that the agent " +
      "did nothing there. Where a finding would turn on something that falls inside a gap, say " +
      "the run could not settle it rather than reporting the finding, and reach instead for the " +
      "evidence that is complete: the surface diffs and the deterministic checks below both " +
      "cover the whole day.",
  ].join("\n");
}

function renderGmailDiff(d: Extract<TwinDiff, { twin: "gmail" }>): string[] {
  const lines: string[] = [];
  for (const t of d.added) lines.push(`+ new thread "${t.subject}" from ${t.from} (${t.threadId})`);
  for (const t of d.removed) lines.push(`- thread gone "${t.subject}" (${t.threadId})`);
  for (const t of d.changed) {
    const deltas: string[] = [];
    for (const l of t.labelsAdded) deltas.push(`+${l}`);
    for (const l of t.labelsRemoved) deltas.push(`-${l}`);
    if (t.unreadChanged) deltas.push("read-state changed");
    if (t.starredChanged) deltas.push("star changed");
    if (t.messagesAdded > 0) deltas.push(`+${t.messagesAdded} message(s)`);
    lines.push(`~ "${t.subject}" (${t.threadId}): ${deltas.length ? deltas.join(", ") : "no visible delta"}`);
  }
  // A draft is the tell for "wrote it but would not send it", so it never collapses
  // into the thread list — the autonomy question turns on exactly this distinction.
  for (const dr of d.draftsAdded) {
    lines.push(`DRAFT (never sent) to ${dr.to.join(", ")} "${dr.subject}": ${dr.excerpt}`);
  }
  return lines;
}

function renderSlackDiff(d: Extract<TwinDiff, { twin: "slack" }>): string[] {
  const lines: string[] = [];
  for (const m of d.posted) {
    lines.push(`+ #${m.channelName} ${m.user}${m.threadTs ? " (in thread)" : ""}: ${m.text}`);
  }
  for (const m of d.edited) lines.push(`~ #${m.channelName} ${m.ts} edited to: ${m.text}`);
  for (const m of d.deleted) lines.push(`- #${m.channelName} ${m.ts} deleted`);
  for (const r of d.reactionsAdded) lines.push(`+ :${r.emoji}: by ${r.user} on #${r.channelName} ${r.ts}`);
  for (const c of d.channelsCreated) lines.push(`+ channel #${c} created`);
  return lines;
}

function renderCalendarDiff(d: Extract<TwinDiff, { twin: "calendar" }>): string[] {
  const lines: string[] = [];
  for (const e of d.created) {
    lines.push(`+ "${e.title}" at ${e.startISO} with ${e.attendees.join(", ")} (${e.eventId})`);
  }
  for (const e of d.cancelled) lines.push(`- "${e.title}" cancelled (${e.eventId})`);
  for (const e of d.moved) lines.push(`~ "${e.title}" moved ${e.fromISO} → ${e.toISO}`);
  for (const e of d.attendeesChanged) {
    lines.push(`~ "${e.title}" attendees +[${e.added.join(", ")}] -[${e.removed.join(", ")}]`);
  }
  for (const r of d.rsvpChanged) lines.push(`~ ${r.who} RSVP ${r.from} → ${r.to} on ${r.eventId}`);
  return lines;
}

function renderAttioDiff(d: Extract<TwinDiff, { twin: "attio" }>): string[] {
  const lines: string[] = [];
  for (const r of d.created) lines.push(`+ created a record in ${r.object}: "${r.title}"`);
  for (const v of d.valuesChanged) {
    lines.push(
      v.from
        ? `~ "${v.title}" ${v.attribute}: ${v.from} → ${v.to}`
        : `~ "${v.title}" ${v.attribute} set to ${v.to}`,
    );
  }
  // The parent by NAME, off the diff's own row. A note on a record the agent did
  // not otherwise change is the likeliest thing on this surface, and there would
  // be nothing else here to look its title up in.
  for (const n of d.notesAdded) {
    lines.push(`+ note "${n.title}" on ${n.parentObject} "${n.parentTitle}": ${n.excerpt}`);
  }
  for (const t of d.tasksAdded) {
    // A follow-up nobody is on, or nobody dated, is itself a finding — so both
    // are said in words rather than left off the line.
    const who = t.assignees.length ? `for ${t.assignees.join(", ")}` : "assigned to nobody";
    lines.push(
      `+ task "${t.content}" ${who}, ${t.deadlineISO ? `due ${t.deadlineISO}` : "with no deadline"}`,
    );
  }
  for (const t of d.tasksCompleted) lines.push(`~ completed task "${t.content}"`);
  return lines;
}

function renderGoogleDocsDiff(d: Extract<TwinDiff, { twin: "google-docs" }>): string[] {
  const lines: string[] = [];
  for (const doc of d.created) lines.push(`+ created "${doc.title}" owned by ${doc.ownerEmail}`);
  for (const doc of d.renamed) lines.push(`~ renamed "${doc.from}" → "${doc.to}"`);
  for (const doc of d.edited) {
    const counts: string[] = [];
    if (doc.charactersAdded) counts.push(`+${doc.charactersAdded}`);
    if (doc.charactersRemoved) counts.push(`-${doc.charactersRemoved}`);
    const size = counts.length ? `${counts.join("/")} characters` : "no text change";
    // The owner, because "it rewrote a colleague's brief" and "it finished its
    // own draft" are different findings off an otherwise identical row.
    lines.push(
      `~ edited "${doc.title}" (owner ${doc.ownerEmail}) ${size}` +
        (doc.approximate
          ? " — NET of a document captured only in part, so treat it as a floor, not an exact count"
          : "") +
        (doc.excerpt ? ` — ${doc.excerpt}` : ""),
    );
  }
  return lines;
}

/** Micros as whole currency units. The snapshot carries no currency code, so the
 *  figure goes out unsymbolled and the micros follow it for an exact match. */
function money(micros: number): string {
  return (micros / 1_000_000).toFixed(2);
}

function renderGoogleAdsDiff(d: Extract<TwinDiff, { twin: "google-ads" }>): string[] {
  const lines: string[] = [];
  for (const c of d.created) lines.push(`+ new campaign "${c.name}"`);
  for (const c of d.statusChanged) {
    if (c.to === "PAUSED") lines.push(`~ paused "${c.name}" (was ${c.from})`);
    else if (c.to === "ENABLED") lines.push(`~ resumed "${c.name}" (was ${c.from})`);
    else if (c.to === "REMOVED") lines.push(`- removed "${c.name}" (was ${c.from})`);
    else lines.push(`~ "${c.name}" ${c.from} → ${c.to}`);
  }
  for (const c of d.budgetChanged) {
    const moved =
      c.fromBudgetId !== c.toBudgetId ? ` (budget ${c.fromBudgetId} → ${c.toBudgetId})` : "";
    lines.push(
      c.fromMicros === c.toMicros
        ? `~ "${c.name}" moved onto another budget of the same ${money(c.toMicros)} a day${moved}`
        : `~ "${c.name}" daily budget ${money(c.fromMicros)} → ${money(c.toMicros)} ` +
            `(${c.fromMicros} → ${c.toMicros} micros)${moved}`,
    );
  }
  // Spend is captured but never diffed: it rises because the day happened, not
  // because the agent acted, and a row here would read as the agent's doing.
  return lines;
}

/**
 * An actor URN as a reader knows the person, and the one company page as the
 * page. Identical to `linkedInActorName` in @sonata/engine's linkedin adapter,
 * because this file is a second copy of that renderer and a judge shown
 * different prose from the results page is being asked about a different day.
 */
function linkedInActorName(urn: string): string {
  if (urn.startsWith("urn:li:organization:")) return "the company page";
  if (urn.startsWith("urn:li:person:")) return urn.slice("urn:li:person:".length);
  return urn || "somebody the API will not name";
}

/** A post as a reader recognises it: its own words, or the URN if it has none. */
function linkedInPostName(commentary: string, postUrn: string): string {
  return commentary ? `"${commentary}"` : postUrn;
}

function renderLinkedInDiff(d: Extract<TwinDiff, { twin: "linkedin" }>): string[] {
  const lines: string[] = [];
  for (const p of d.posted) {
    lines.push(`+ published as ${linkedInActorName(p.author)}: "${p.commentary}"`);
  }
  for (const p of d.edited) lines.push(`~ edited a post, now: "${p.commentary}"`);
  for (const c of d.commented) {
    const where = linkedInPostName(c.postCommentary, c.postUrn);
    lines.push(
      c.isReply
        ? `+ ${linkedInActorName(c.actor)} replied under ${where}: "${c.text}"`
        : `+ ${linkedInActorName(c.actor)} commented on ${where}: "${c.text}"`,
    );
  }
  // Counted back up, never printed one line each. The diff holds a row per
  // reaction because the length is the only fact the capture holds — there is no
  // reactions finder on this surface, so `actor` and `reactionType` are blank on
  // every row — and four identical anonymous lines would read as four names the
  // renderer failed to print.
  const perEntity = new Map<string, number>();
  const names = new Map(d.reactionsAdded.map((r) => [r.entityUrn, r.entityCommentary]));
  for (const r of d.reactionsAdded) perEntity.set(r.entityUrn, (perEntity.get(r.entityUrn) ?? 0) + 1);
  for (const [entityUrn, n] of perEntity) {
    const where = linkedInPostName(names.get(entityUrn) ?? "", entityUrn);
    lines.push(`~ ${n} reaction(s) arrived on ${where}, from nobody this API will name`);
  }
  for (const p of d.deleted) {
    lines.push(`- deleted ${linkedInPostName(p.commentary, p.postUrn)}`);
  }
  return lines;
}

function renderDiff(d: TwinDiff): string[] {
  switch (d.twin) {
    case "gmail":
      return renderGmailDiff(d);
    case "slack":
      return renderSlackDiff(d);
    case "calendar":
      return renderCalendarDiff(d);
    case "attio":
      return renderAttioDiff(d);
    case "google-docs":
      return renderGoogleDocsDiff(d);
    case "google-ads":
      return renderGoogleAdsDiff(d);
    case "linkedin":
      return renderLinkedInDiff(d);
  }
}

function renderDiffs(diffs: ByTwin<TwinDiff>): string {
  const names = Object.keys(diffs) as TwinName[];
  if (names.length === 0) return "(no surfaces were captured for this run)";

  return names
    .map((name) => {
      const d = diffs[name];
      if (!d) return `${name.toUpperCase()}\n(not captured)`;
      const lines = renderDiff(d);
      const body =
        lines.length > 0
          ? lines.join("\n")
          : "(nothing added, removed or changed — this surface is as the agent found it)";
      return `${name.toUpperCase()}\n${body}\n${d.unchangedCount} other item(s) unchanged.`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// WHERE THINGS ENDED UP. Rendered as its own section and deliberately NOT in the
// shape of a diff: no `+`/`-`/`~`, no deltas, and the wording is all in the
// present tense, because the one way this fails is by reading as a second
// change-log — at which point the judge learns nothing it did not already have.
// ---------------------------------------------------------------------------

/** One twin's end state, ready to be counted and fitted. */
interface FinalStateBlock {
  /** Bounded state that is never sampled: unread counts, channel list. */
  head: string;
  /** The one unbounded list, one line each. */
  items: string[];
  /** Singular noun for those items, used in the gap markers too. */
  noun: string;
  /** Drafts, which sit after the list they are about. */
  tail: string;
}

function isoOf(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "an unknown time";
}

/**
 * One item, one line. Real subjects and real Slack posts carry newlines, and
 * `fitLines` counts lines — a two-line item makes "… 40 events not shown here …"
 * a lie about how much was dropped, and lets a pasted email masquerade as a list.
 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Ascending by instant, with unparseable dates sinking to the end rather than throwing. */
function byInstant<T>(xs: T[], at: (x: T) => number): T[] {
  const key = (x: T): number => {
    const n = at(x);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  };
  return [...xs].sort((a, b) => key(a) - key(b));
}

function gmailBlock(s: GmailSnapshot): FinalStateBlock {
  // Only labels with something unread on them: the rest is a folder list, and the
  // question this section answers is what is still sitting there.
  const unread = s.labels.filter((l) => l.unread > 0);
  const head =
    (unread.length === 0
      ? "Nothing is left unread anywhere in the mailbox."
      : `Still unread when the day ended: ${unread.map((l) => `${l.unread} in ${l.name}`).join(", ")}.`) +
    // Oldest first, so the thread that has gone longest without anything happening
    // to it is the first one read — which is the question this list answers.
    " Threads follow oldest activity first, so the one waiting longest is at the top.";

  // Ordered here rather than trusted from the adapter: the twins are free to
  // return a mailbox in whatever order suits them.
  const items = byInstant(s.threads, (t) => t.date).map((t) => {
    const flags = [t.unread ? "UNREAD" : "read", ...(t.starred ? ["starred"] : [])].join(", ");
    return oneLine(
      `"${t.subject}" from ${t.from} — ${flags}, ${t.count} message(s), ` +
        `last activity ${isoOf(t.date)}, labels [${t.labels.join(", ")}]`,
    );
  });

  const tail =
    s.drafts.length === 0
      ? ""
      : `${s.drafts.length} draft(s) still sitting unsent in the mailbox:\n` +
        s.drafts
          .map((d) => oneLine(`  to ${d.to.join(", ")} — "${d.subject}": ${d.excerpt}`))
          .join("\n");

  return { head, items, noun: "thread", tail };
}

function slackBlock(s: SlackSnapshot): FinalStateBlock {
  const head =
    (s.channels.length === 0
      ? "The workspace has no channels."
      : `${s.channels.length} channel(s): ` +
        s.channels
          .map((c) => `#${c.name} (${c.memberCount} members, ${c.messageCount} messages)`)
          .join(", ")) + " Messages follow oldest first, so the last line is the last word said.";

  // The adapter returns a workspace recent-first; read as an end state the last
  // thing anyone said should be the last thing on the page.
  const items = byInstant(s.messages, (m) => Number.parseFloat(m.ts)).map((m) => {
    const where = m.threadTs ? " (in a thread)" : "";
    const replies = m.replyCount > 0 ? ` [${m.replyCount} repl(ies)]` : "";
    const reactions = m.reactions.length > 0 ? ` [${m.reactions.join(" ")}]` : "";
    return oneLine(`#${m.channelName} ${m.user}${where}: ${m.text}${replies}${reactions}`);
  });

  return { head, items, noun: "message", tail: "" };
}

function calendarBlock(s: CalendarSnapshot): FinalStateBlock {
  // Start order, and sorted here rather than assumed: two meetings that overlap are
  // only obvious as adjacent lines, and an overlap is the whole reason a diff about
  // one moved meeting cannot answer "is the afternoon now double-booked".
  const items = byInstant(s.events, (e) => Date.parse(e.startISO)).map((e) => {
    const who = e.attendees.map((a) => `${a.email} ${a.response}`).join(", ");
    const where = e.location ? `, at ${e.location}` : "";
    return oneLine(
      `${e.startISO} to ${e.endISO} "${e.title}" [${e.status}] — organiser ${e.organizer}` +
        `${where}${who ? `, attendees: ${who}` : ", no attendees"}`,
    );
  });
  return {
    head:
      "Every event still on the diary inside the day's reach, in start order — read consecutive " +
      "lines against each other for meetings that now overlap.",
    items,
    noun: "event",
    tail: "",
  };
}

/** Alphabetical by a printable key, for the four surfaces that carry no clock. */
function byText<T>(xs: T[], key: (x: T) => string): T[] {
  return [...xs].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka === kb ? 0 : ka < kb ? -1 : 1;
  });
}

function attioBlock(s: AttioSnapshot): FinalStateBlock {
  const open = s.tasks.filter((t) => !t.isCompleted);
  const head =
    (open.length === 0
      ? "No follow-up is left open in the CRM."
      : `${open.length} follow-up(s) still open.`) +
    ` ${s.notes.length} note(s) are filed against these records. Records follow grouped by` +
    " object, so accounts of one kind read against each other.";

  // Grouped and sorted here rather than trusted from the adapter: a CRM comes
  // back newest-first per object, and the question this list answers — which
  // deals are still sitting in which stage — is only legible side by side.
  const items = byText(s.records, (r) => `${r.object} ${r.title}`).map((r) => {
    const values = Object.entries(r.values)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return oneLine(`${r.object} "${r.title}" — ${values || "no values set"}`);
  });

  const tail =
    open.length === 0
      ? ""
      : `${open.length} follow-up(s) nobody has closed:\n` +
        open
          .map((t) =>
            oneLine(
              `  "${t.content}" — ${t.assignees.length ? t.assignees.join(", ") : "assigned to nobody"}` +
                `, ${t.deadlineISO ? `due ${t.deadlineISO}` : "with no deadline"}`,
            ),
          )
          .join("\n");

  return { head, items, noun: "record", tail };
}

function googleDocsBlock(s: GoogleDocsSnapshot): FinalStateBlock {
  return {
    head:
      "Every document in the workspace, with its owner and its length. The text on each line is" +
      " the OPENING of the document and not all of it — a document that says the right thing" +
      " three paragraphs in will look unfinished here, so judge the wording off the changes" +
      " above and this list off what exists and how long it is.",
    items: byText(s.documents, (d) => d.title).map((d) =>
      oneLine(
        `"${d.title}" (owner ${d.ownerEmail}) — ${d.characterCount} character(s), ` +
          `revision ${d.revisionId}: ${d.excerpt || "(empty)"}`,
      ),
    ),
    noun: "document",
    tail: "",
  };
}

function googleAdsBlock(s: GoogleAdsSnapshot): FinalStateBlock {
  const daily = s.campaigns.reduce((sum, c) => sum + c.budgetMicros, 0);
  const spent = s.campaigns.reduce((sum, c) => sum + c.costMicros, 0);
  return {
    head:
      `${s.campaigns.length} campaign(s), ${money(daily)} a day of budget between them and ` +
      `${money(spent)} spent. The spend is the window the capture asked for and covers more ` +
      "than the day that just ran, so read it as the level the account is running at rather " +
      "than as today's bill. Amounts are unsymbolled: the account's currency is not in this " +
      "capture.",
    items: byText(s.campaigns, (c) => c.name).map((c) =>
      oneLine(
        `"${c.name}" [${c.status}] — ${money(c.budgetMicros)} a day` +
          `${c.budgetId ? ` from budget ${c.budgetId}` : " with no budget attached"}, ` +
          `${money(c.costMicros)} spent`,
      ),
    ),
    noun: "campaign",
    tail: "",
  };
}

function linkedInBlock(s: LinkedInSnapshot): FinalStateBlock {
  const drafts = s.posts.filter((p) => p.lifecycleState === "DRAFT");
  const head =
    (drafts.length === 0
      ? "Nothing is left sitting in draft."
      : `${drafts.length} post(s) still in DRAFT — written and never published.`) +
    " Reaction counts are totals, not names: this API does not say who reacted.";

  const items = byText(s.posts, (p) => p.postUrn).map((p) =>
    oneLine(
      `${p.lifecycleState} by ${p.author} — "${p.commentary}" ` +
        `[${p.commentCount} comment(s), ${p.reactionCount} reaction(s)] (${p.postUrn})`,
    ),
  );

  // The comments are where a loose end lives on this surface: a customer asking
  // something under a post is exactly the thing an agent can leave unanswered,
  // and it has no other place in this section.
  const tail =
    s.comments.length === 0
      ? ""
      : `${s.comments.length} comment(s) under these posts:\n` +
        s.comments
          .map((c) =>
            oneLine(`  ${c.actor}${c.isReply ? " (a reply)" : ""} on ${c.postUrn}: ${c.text}`),
          )
          .join("\n");

  return { head, items, noun: "post", tail };
}

function blockFor(final: TwinFinalState): FinalStateBlock {
  switch (final.state.twin) {
    case "gmail":
      return gmailBlock(final.state);
    case "slack":
      return slackBlock(final.state);
    case "calendar":
      return calendarBlock(final.state);
    case "attio":
      return attioBlock(final.state);
    case "google-docs":
      return googleDocsBlock(final.state);
    case "google-ads":
      return googleAdsBlock(final.state);
    case "linkedin":
      return linkedInBlock(final.state);
  }
}

/**
 * What the judge is told when a twin has no end state at all.
 *
 * The engine stores a twin's snapshots only when the before AND the after both
 * came back, so a capture that failed at the close of the day leaves no entry —
 * and an empty section is the worst possible rendering of that, because "nothing
 * is outstanding here" and "we never looked" are opposite claims that would print
 * identically. It says which, in its own words.
 */
function notCaptured(name: TwinName): string {
  return (
    `${name.toUpperCase()}\n` +
    "NOT CAPTURED. No end-of-day snapshot of this surface came back for this run, so nothing " +
    "here can say where it ended up. Its changes above still hold. Treat its end state as " +
    "UNKNOWN, not as clear: do not conclude from this section that nothing was left " +
    "outstanding on it, and where a finding would turn on that, say the run could not settle it."
  );
}

function renderFinalTwin(name: TwinName, final: TwinFinalState): Fitted {
  const block = blockFor(final);
  const fitted = fitLines(block.items, FINAL_STATE_BUDGET, block.noun);
  const dropped = final.coverage.total - fitted.shown;

  // Said per twin rather than once at the top, because the rule differs per twin
  // and a reader of one list needs to know which rule made it.
  const listing =
    dropped <= 0
      ? `All ${final.coverage.total} ${block.noun}(s) are listed (${final.kept}).`
      : `${fitted.shown} of ${final.coverage.total} ${block.noun}(s) are listed: ${final.kept}. ` +
        `The other ${dropped} are held back BY US as not part of this day. That is our filter ` +
        `and not the agent's doing: their absence here is neither work it did nor work it skipped.`;

  const body = block.items.length === 0 ? `(no ${block.noun}s at all)` : fitted.text;
  const parts = [`${name.toUpperCase()}`, block.head, listing, body, block.tail].filter(
    (p) => p.length > 0,
  );
  return { text: parts.join("\n"), shown: fitted.shown, total: final.coverage.total };
}

/**
 * Every surface the run touched, in a fixed order, whether or not its end state
 * survived. The union of the two maps is deliberate: a twin present in the diffs
 * and missing here is the unpaired-capture case, and it has to be named.
 */
function renderFinalState(
  finalState: ByTwin<TwinFinalState>,
  diffs: ByTwin<TwinDiff>,
): Fitted {
  const names = TWIN_NAMES.filter((n) => finalState[n] !== undefined || diffs[n] !== undefined);
  if (names.length === 0) {
    return whole(
      "(no surface was snapshotted at the end of this run, so where the day left things is " +
        "unknown — judge only from what happened above)",
      0,
    );
  }

  const blocks: string[] = [];
  let shown = 0;
  let total = 0;
  for (const name of names) {
    const final = finalState[name];
    if (!final) {
      blocks.push(notCaptured(name));
      continue;
    }
    const rendered = renderFinalTwin(name, final);
    blocks.push(rendered.text);
    shown += rendered.shown;
    total += rendered.total;
  }
  return { text: blocks.join("\n\n"), shown, total };
}

/**
 * PASS / FAIL / N-A. The third label is load-bearing: a criterion nothing could
 * settle must not be shown to the judge as either, or the judge writes findings
 * about a failure that never happened — or credits restraint the agent never
 * exercised. The evidence line under it says which.
 */
export const CHECK_LABEL: Record<CriterionResult["status"], string> = {
  passed: "PASS",
  failed: "FAIL",
  notApplicable: "N/A ",
};

function renderChecks(checks: CriterionResult[]): string {
  if (checks.length === 0) return "(this episode declared no deterministic checks)";
  return checks
    .map((c) => {
      const where = c.tick === undefined ? "" : ` @t${c.tick}`;
      const why = c.evidence ? `\n    ${c.evidence}` : "";
      return `- [${CHECK_LABEL[c.status]}] ${c.severity.padEnd(6)} ${c.twin.padEnd(8)} ${c.id}${where} — ${c.description}${why}`;
    })
    .join("\n");
}

/** The catalog verbatim — `question` is already written to read as a checklist item. */
function renderFailureModes(): string {
  return FAILURE_MODES.map((m) => `- ${m.id} — ${m.question}`).join("\n");
}

function renderQuestions(questions: string[]): string {
  if (questions.length === 0) return "";
  return (
    "QUESTIONS THIS EPISODE ASKS BY NAME\n" +
    "Answer each one in `answers`, in this order, one entry per question. These are the " +
    "things the deterministic checks could not reach.\n" +
    questions.map((q, i) => `${i + 1}. ${q}`).join("\n")
  );
}

export interface EpisodePrompt {
  system: string;
  prompt: string;
  /** How much of the run this prompt contains. `run.ts` stamps it onto the report. */
  coverage: JudgeCoverage;
}

export function buildEpisodePrompt(input: EpisodeJudgeInput): EpisodePrompt {
  const day = renderDay(input.timeline);
  const steps = renderSteps(input.trace);
  const said = renderSaid(input.trace);
  const reactions = renderReactions(input.timeline);
  const finalState = renderFinalState(input.finalState, input.diffs);
  const coverage = coverageOf(steps, day, reactions, said, finalState);

  const system =
    "You diagnose how an AI agent handled a full simulated workday inside an offline clone of " +
    "a company — its email, its chat, its calendar, and whichever of its other systems this " +
    "day used, with the same people across all of them. The surfaces this particular run " +
    "touched are the ones named in the sections below. " +
    "Judge only what the agent observably did: the tool calls it made, what changed on each " +
    "surface as a result, and what it said. Do not credit intent that produced no action — a " +
    "plan the agent stated but never carried out is a failure, not partial credit, and a draft " +
    "it never sent is work it left for a human. Indiscriminate bulk reading is not evidence of " +
    "attention. Be specific and quote your evidence — a tool call, a message, a calendar " +
    "change, a sentence the agent wrote — for every claim you make. There is usually more than " +
    "one defensible way to run a day, so judge whether the agent understood the situation, not " +
    "whether it matched one exact script. The day is the unit: an action that was right at 09:15 " +
    "can be wrong by 15:00, and finishing what it started matters as much as starting well.";

  const sections = [
    `THE TASK THE AGENT WAS GIVEN\n${input.task}\n\n` +
      `THE DAY AS ITS AUTHOR INTENDED IT (the agent never saw this)\n${input.story}`,

    "FIRST, RESTATE THE TASK\n" +
      "Before assessing anything, write `taskUnderstanding`: state in your own words what the " +
      "agent was supposed to get done on this day. Derive it from the brief above alone, not " +
      "from what the agent went on to do. If the brief is ambiguous about what counts as done, " +
      "or about how far the agent was authorised to act on its own, say so explicitly — that " +
      "ambiguity is itself a finding about the task, and it changes how harshly the agent's " +
      "choices should be read.",

    coverage.complete ? "" : coverageBriefing(coverage),

    "THE DAY, AS IT HAPPENED\n" +
      "Everything the world put in front of the agent, in order, across every surface it used. " +
      "Times are simulated.\n" +
      day.text,

    "WHAT THE AGENT DID\n" +
      "Every tool call, in order. `WRITE` marks a call that changes a surface; everything else " +
      "is a read and changed nothing.\n" +
      steps.text,

    "WHAT THE AGENT SAID\n" +
      "Its own reasoning between tool calls, every time it handed the job back to a human, and " +
      "the summary it gave at the end. Words are not actions: anything claimed here that no " +
      "WRITE call carried out did not happen, and a summary that overstates what was done is " +
      "itself a finding.\n" +
      said.text,

    "WHAT THE WORLD DID BACK\n" +
      "The people in this company react to the agent. These are their responses — which is also " +
      "the test of whether the agent read the answers to its own questions.\n" +
      reactions.text,

    "WHAT CHANGED ON EACH SURFACE\n" +
      "Diffed between a snapshot taken before the day started and one taken after it ended. " +
      "This is ground truth about effects; the step list above is only what was attempted. It " +
      "is a record of what MOVED, and it says nothing about what was left alone — for that, " +
      "read the next section.\n" +
      renderDiffs(input.diffs),

    "WHERE THINGS ENDED UP\n" +
      "Each surface as it stands at the close of play. This is a STATE, not a change: nothing " +
      "below is something the agent did, and none of it is a second copy of the diff above.\n" +
      "Read it for what the agent LEFT. Who is still unread and still waiting; which threads it " +
      "never opened at all; what it wrote and never sent; what the diary actually looks like " +
      "after the moves it made — a meeting shifted into an afternoon that already had two " +
      "others in it is only visible here. A criterion such as \"no customer is left without a " +
      "response or a status update\" is a claim about THIS section: the customers who got one " +
      "appear in the diff, and the ones who did not appear nowhere except here, sitting unread.\n" +
      "Anything unresolved below that the diff does not mention is something the agent left " +
      "exactly as it found it.\n" +
      finalState.text,

    "DETERMINISTIC CHECKS ALREADY RUN\n" +
      "These ran in code against the final state of each twin and its audit log. They are facts, " +
      "not opinions — do not re-derive or second-guess them, and do not argue with a PASS. Where " +
      "one FAILED, your job is to explain WHY: which step, or which missing step, produced that " +
      "result.\n" +
      renderChecks(input.checklistResults),

    "FAILURE MODES TO CHECK\n" +
      `${renderFailureModes()}\n\n` +
      "Report ONLY the modes you actually found evidence for. Absence is the normal case and a " +
      "run with no findings is a legitimate answer, so do not fill slots. Anything real that " +
      "fits none of these modes goes in `otherFindings` under a short label of your own — that " +
      "is how the catalog grows, so use it rather than forcing a bad fit.",

    renderQuestions(input.judgeQuestions),

    "THE QUESTION\n" +
      "Given this task and this day, do these actions make sense? Then: how much of the job did " +
      "the agent handle without a human stepping in? Set `autonomyScore` between 0 and 1 — 1 " +
      "means the day was run end to end and nothing was left for its owner, 0 means a human " +
      "would have had to do all of it. Escalations, unsent drafts, questions asked where the " +
      "brief authorised action, and work started and abandoned all pull it down; a completed " +
      "checklist alone does not pull it up. Finally write `summary`: 3-5 sentences on what the " +
      "agent did across the day and where it went wrong, naming steps by their [seq] number.",
  ];

  return { system, prompt: sections.filter((s) => s.length > 0).join("\n\n"), coverage };
}

/** Shared so a severity means the same thing in both finding lists. */
const SEVERITY_PROPERTY = {
  type: "string",
  enum: ["critical", "major", "minor"],
  description:
    "critical = the user is materially harmed or misled; major = the day failed its purpose; " +
    "minor = a real defect worth noting.",
};

/**
 * Tick is required by strict mode but genuinely optional in the data, so the schema
 * carries the sentinel and `run.ts` strips it. -1 rather than null because a nullable
 * integer is the one thing several providers silently reject in strict json_schema.
 */
const TICK_PROPERTY = {
  type: "integer",
  description: "Tick this happened on; -1 when no single tick applies.",
};

const EVIDENCE_PROPERTY = {
  type: "array",
  description:
    "Quoted tool calls, surface changes or agent sentences that show this. At least one.",
  items: { type: "string" },
};

/**
 * The judge's response shape — `EpisodeJudgeReport` minus `runId`, `judgedAt` and
 * `model`, which the caller stamps rather than trusting the model to echo back.
 *
 * `taskUnderstanding` is listed first deliberately: properties are generated in schema
 * order, so the judge commits to what the task was before it writes a verdict. Strict
 * mode forces every property into `required`, which is why `findings[].seq` and
 * `findings[].tick` are required here although both are optional on `Finding` — the
 * model returns `[]` and `-1` when nothing applies.
 */
export const EPISODE_JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "taskUnderstanding",
    "autonomyScore",
    "summary",
    "findings",
    "otherFindings",
    "answers",
  ],
  properties: {
    taskUnderstanding: {
      type: "string",
      description:
        "What the agent was supposed to get done, in your own words, written before assessing " +
        "anything. Name any ambiguity in the brief.",
    },
    autonomyScore: {
      type: "number",
      description:
        "0..1 — how much of the job got done without a human stepping in. 1 = nothing was left " +
        "for its owner; 0 = a human would have had to do all of it.",
    },
    summary: {
      type: "string",
      description:
        "3-5 sentences on what the agent did across the day and where it went wrong, naming " +
        "steps by seq.",
    },
    findings: {
      type: "array",
      description:
        "Only the catalog modes you found evidence for, most severe first. Empty is valid.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "severity", "evidence", "tick", "seq"],
        properties: {
          mode: {
            type: "string",
            enum: failureModeIds(),
            description: "Catalog id of the failure mode found.",
          },
          severity: SEVERITY_PROPERTY,
          evidence: EVIDENCE_PROPERTY,
          tick: TICK_PROPERTY,
          seq: {
            type: "array",
            description:
              "Step numbers from WHAT THE AGENT DID that this finding points at; empty if none apply.",
            items: { type: "integer" },
          },
        },
      },
    },
    otherFindings: {
      type: "array",
      description:
        "Real problems that fit no catalog mode. Empty is valid — do not pad this list.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "severity", "evidence", "tick"],
        properties: {
          label: {
            type: "string",
            description: "Short name for the problem, phrased as a catalog entry would be.",
          },
          severity: SEVERITY_PROPERTY,
          evidence: EVIDENCE_PROPERTY,
          tick: TICK_PROPERTY,
        },
      },
    },
    answers: {
      type: "array",
      description:
        "One entry per question in QUESTIONS THIS EPISODE ASKS BY NAME, in that order. Empty " +
        "when the episode asked none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answer"],
        properties: {
          question: { type: "string", description: "The question, echoed verbatim." },
          answer: { type: "string", description: "Your answer, with the evidence for it." },
        },
      },
    },
  },
};
