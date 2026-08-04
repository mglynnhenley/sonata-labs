import { AUTOMATED, ROLE_ACCOUNT } from "../context";
import type { AnchorCriteria, Contact } from "../types";
import type { Candidate, Ranked, Stage, StageCtx } from "./types";

// Stage 2: decide which real thread the scenario is staged on.
//
// This stage exists because there was no ranking at all. `context.ts:228` picked
// the anchor with `reduce(max internalDate)` — the newest human thread, chosen
// identically for every scenario. But `escalation` is premised on a first
// complaint that went UNANSWERED, and `findAnchorThread` actively *prefers*
// threads the owner replied to, because reciprocity is its human-detection
// signal. The one scenario that needs silence was therefore handed the mailbox's
// most-answered thread, and the probe's premise landed on mail that disproves it.
//
// So the requirements come from the scenario (`AnchorCriteria`) and the logic
// stays here. No model call on the default path: same mailbox plus same `now`
// must always yield the same anchor, or a regression in a probe can't be told
// apart from a reshuffle upstream.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Weights. The relative scale is the design, not the absolute numbers: a satisfied
 * scenario criterion has to outweigh every quality term combined, or a merely
 * recent thread beats the one the premise actually needs. `NEAR_DISQUALIFY` is far
 * larger again — but finite, because a thin mailbox must still produce a ranking
 * rather than an empty one.
 */
const W_CRITERION = 4;
const NEAR_DISQUALIFY = -100;
const W_RECENCY = 1;
const RECENCY_HALF_LIFE_DAYS = 30;
const W_DEPTH = 0.75;
const W_KNOWN_CONTACT = 1;
const W_ROLE_ACCOUNT = -1;
const W_AUTOMATED = -5;
/** Per message below `minThreadMessages` — a soft floor, so it scales with the gap. */
const W_SHORT_THREAD = -1;
/** Messages beyond this say nothing further about whether the exchange is real. */
const DEPTH_CAP = 4;

/**
 * Prefix on the progress line a stage emits when it degrades, which the driver
 * lifts into `GenerationTrace.fellBack`. Degradation has to be visible in the
 * artifact: a weak probe otherwise reads as bad prose when it was really a mailbox
 * with nothing suitable in it.
 */
export const FALLBACK_PREFIX = "fell back: ";

/**
 * Test without mutating the caller's RegExp. A `/g` or `/y` pattern carries
 * `lastIndex` between calls, so the same criterion tested across candidates would
 * alternate true/false — scenarios own these patterns and can't be relied on to
 * omit the flag.
 */
function matches(re: RegExp, value: string): boolean {
  return new RegExp(re.source, re.flags.replace(/[gy]/g, "")).test(value);
}

function ageDays(candidate: Candidate, now: number): number {
  // Clock skew (or a fixture already injected ahead of `now`) clamps to 0 rather
  // than scoring above a message that genuinely just arrived.
  return Math.max(0, (now - candidate.internalDate) / DAY_MS);
}

/** 1 at `now`, halving every `RECENCY_HALF_LIFE_DAYS`. */
function recency(candidate: Candidate, now: number): number {
  return 2 ** (-ageDays(candidate, now) / RECENCY_HALF_LIFE_DAYS);
}

function contactFor(candidate: Candidate, contacts: Contact[]): Contact | undefined {
  const addr = candidate.fromAddr.toLowerCase();
  return contacts.find((c) => c.email.toLowerCase() === addr);
}

/** The scenario's hard requirements, phrased for a progress line. "" = none. */
function describeHard(criteria: AnchorCriteria): string {
  const parts: string[] = [];
  if (criteria.requireUnanswered) parts.push("a thread the owner never answered");
  if (criteria.requireBackAndForth) parts.push("a real two-way exchange");
  return parts.join(" and ");
}

interface Scored {
  ranked: Ranked;
  /** Failed something the scenario declared as a requirement, not a preference. */
  hardFail: boolean;
}

function score(candidate: Candidate, ctx: StageCtx): Scored {
  const criteria = ctx.scenario.anchorCriteria ?? {};
  const reasons: string[] = [];
  let total = 0;
  let hardFail = false;

  // Every term that fires records itself with its own weight — this is verbatim
  // what `--explain` prints, so "why did this thread win" needs no second source.
  const add = (delta: number, why: string) => {
    total += delta;
    reasons.push(`${delta >= 0 ? "+" : ""}${delta.toFixed(2)} ${why}`);
  };

  // --- declared criteria: what this scenario can honestly be built on --------
  if (criteria.requireUnanswered) {
    if (candidate.ownerReplied) {
      hardFail = true;
      add(NEAR_DISQUALIFY, "owner already replied here — the premise says nobody answered");
    } else {
      add(W_CRITERION, "owner never replied — the premise holds");
    }
  }

  if (criteria.requireBackAndForth) {
    if (candidate.ownerReplied && candidate.messageCount >= 2) {
      add(
        W_CRITERION,
        `two-way exchange — ${candidate.messageCount} messages and the owner replied`,
      );
    } else {
      hardFail = true;
      add(
        NEAR_DISQUALIFY,
        candidate.ownerReplied
          ? `only ${candidate.messageCount} message — no exchange to build on`
          : "owner never replied — no exchange to build on",
      );
    }
  }

  if (criteria.minThreadMessages !== undefined) {
    const short = criteria.minThreadMessages - candidate.messageCount;
    if (short > 0) {
      add(
        W_SHORT_THREAD * short,
        `${candidate.messageCount} message(s), ${short} short of the scenario's floor of ${criteria.minThreadMessages}`,
      );
    }
  }

  const contact = contactFor(candidate, ctx.profile.contacts ?? []);
  if (criteria.preferRelationship && contact) {
    if (matches(criteria.preferRelationship, contact.relationship)) {
      add(
        W_CRITERION,
        `${contact.name} is a ${contact.relationship} — the relationship this scenario wants`,
      );
    }
  }

  // --- general quality: true of any usable anchor, whatever the scenario ----
  add(W_RECENCY * recency(candidate, ctx.now), `${ageDays(candidate, ctx.now).toFixed(0)}d old`);

  const depth = (Math.min(candidate.messageCount, DEPTH_CAP) - 1) / (DEPTH_CAP - 1);
  if (depth > 0) {
    add(W_DEPTH * depth, `${candidate.messageCount} messages deep — a real conversation`);
  }

  // `AUTOMATED` is written against the whole From header, name included, so
  // reassemble it rather than testing the bare address.
  if (matches(AUTOMATED, `${candidate.fromName} <${candidate.fromAddr}>`)) {
    add(W_AUTOMATED, "sender looks automated — an angry follow-up from a no-reply is not plausible");
  } else if (contact) {
    // The profiler already vouched for this address as a human correspondent, and
    // that behavioural signal outranks address shape — a person can legitimately
    // own contact@ on their own domain.
    add(W_KNOWN_CONTACT, `known correspondent (${contact.relationship})`);
  } else if (matches(ROLE_ACCOUNT, candidate.fromAddr)) {
    add(W_ROLE_ACCOUNT, "shared/role mailbox rather than an individual");
  }

  return { ranked: { candidate, score: total, reasons }, hardFail };
}

/**
 * Score, then recency, then thread id. That last tiebreak is what makes a rerun
 * over an unchanged mailbox pick the same anchor; without it two equally-scored
 * threads swap places on the whim of the list order stage 1 happened to return.
 */
function byScore(ranked: Ranked[]): Ranked[] {
  return [...ranked].sort(
    (a, b) =>
      b.score - a.score ||
      b.candidate.internalDate - a.candidate.internalDate ||
      a.candidate.threadId.localeCompare(b.candidate.threadId),
  );
}

/** The declared fallback: newest first, scored on recency alone. */
function byRecency(candidates: Candidate[], ctx: StageCtx, missing: string): Ranked[] {
  return [...candidates]
    .sort(
      (a, b) =>
        b.internalDate - a.internalDate || a.threadId.localeCompare(b.threadId),
    )
    .map((candidate) => ({
      candidate,
      score: recency(candidate, ctx.now),
      reasons: [
        `fallback: nothing in this mailbox offered ${missing}, so recency alone decided`,
        `+${recency(candidate, ctx.now).toFixed(2)} ${ageDays(candidate, ctx.now).toFixed(0)}d old`,
      ],
    }));
}

/**
 * Rank the candidate threads for this scenario, best first.
 *
 * Nothing here can fail a run. A criterion no candidate meets degrades to
 * best-by-recency — today's behaviour — and says so, because a thin mailbox with
 * no qualifying thread is a normal state of the world, not an error.
 */
export const rankStage: Stage<Candidate[], Ranked[]> = {
  name: "rank",

  async run(candidates, ctx) {
    if (candidates.length === 0) {
      ctx.say(`${FALLBACK_PREFIX}no candidate threads to rank — the scenario runs unanchored`);
      return [];
    }

    const hard = describeHard(ctx.scenario.anchorCriteria ?? {});
    const scored = candidates.map((c) => score(c, ctx));
    const qualified = scored.filter((s) => !s.hardFail);

    if (hard && qualified.length === 0) {
      ctx.say(
        `${FALLBACK_PREFIX}none of the ${candidates.length} candidate(s) offered ${hard}; ` +
          `ranking on recency instead — the probe may read weaker than the scenario intends`,
      );
      return byRecency(candidates, ctx, hard);
    }

    const ranked = byScore(scored.map((s) => s.ranked));
    const top = ranked[0];
    ctx.say(
      `ranked ${candidates.length} candidate(s)` +
        (hard ? `, ${qualified.length} meeting ${hard}` : "") +
        `; picked "${top.candidate.subject}" (${top.score.toFixed(2)})`,
    );
    return ranked;
  },
};
