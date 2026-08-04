import type { MessageSlot } from "../types";
import type { SlotTime, Stage, Timeline } from "./types";

// ---------------------------------------------------------------------------
// Stage 4 — dates. Pure code, no model call, no I/O.
//
// This is the step that was broken. A slot declares `minutesAgo`, which is an
// offset from *now* and is never compared against the thread the probe is being
// stapled onto; `Anchor` carried no timestamp at all until this initiative. So the
// generator was told "continue this real thread" without being told whether the
// thread is from Tuesday or from April, and it wrote "as I mentioned yesterday"
// onto three-month-old mail. The agent under test then gets a probe whose own
// history contradicts it — an unfair test, and one that hides real failures.
//
// So every timestamp is resolved here, in code, against the anchor's real
// `internalDate`, and every date the composer is allowed to mention comes back as
// a ready-made `phrase` it can quote verbatim. Nothing here reads the clock:
// `now` is injected via `StageCtx`, which is what makes all of this testable.
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How far after the anchor a rebased slot lands. A reply timestamped in the same
 * millisecond as the message it answers reads as machine-generated, and one minute
 * is the smallest gap that still reads like a person hitting send.
 */
const MIN_GAP_MS = MINUTE;

/** `anchorPhrase` when the run has no anchor thread; `anchorLastAt` is 0 then too. */
export const NO_ANCHOR_PHRASE = "no anchor thread";

/** What stage 4 needs from the chosen anchor — its last message's real send time. */
export interface TimelineInput {
  /** Epoch ms of the anchor thread's last message; null when the run has no anchor. */
  anchorLastAt: number | null;
}

// Fixed English names rather than `toLocaleDateString`, whose output depends on the
// runner's locale and ICU build — the same fixture must phrase a date identically on
// every machine, or the tests that guard this stage are worthless.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function ago(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** UTC calendar day index. Epoch days start at UTC midnight, so this is exact. */
function utcDay(ms: number): number {
  return Math.floor(ms / DAY);
}

/** Whole calendar months between two instants, so "3 months ago" means three months. */
function monthsBetween(from: Date, to: Date): number {
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth());
  return to.getUTCDate() < from.getUTCDate() ? months - 1 : months;
}

/**
 * Render `at` the way a person would say it out loud relative to `now`:
 * "25 minutes ago", "yesterday", "Tue 14 Apr, 3 months ago".
 *
 * Anything older than a day carries the absolute date as well as the relative age,
 * because those are the two things the composer keeps getting wrong at once — it
 * needs to know both that the thread is old *and* which day it stopped on.
 *
 * Everything is computed in UTC and from `now` alone, never `Date.now()`.
 * A future `at` can only arrive from a caller that skipped `rebaseSlots`; it renders
 * as "just now" because every consumer is prose about something that already
 * happened, and the stage guarantees the future case never reaches the composer.
 */
export function humanPhrase(at: number, now: number): string {
  const elapsed = now - at;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return ago(Math.floor(elapsed / MINUTE), "minute");

  // Days are counted by calendar date, not by elapsed hours: 11pm yesterday is
  // "yesterday" at 1am, not "2 hours ago".
  const days = utcDay(now) - utcDay(at);
  if (days === 0) return ago(Math.floor(elapsed / HOUR), "hour");
  if (days === 1) return "yesterday";

  const d = new Date(at);
  const stamp = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (days < 7) return `${stamp}, ${ago(days, "day")}`;

  const months = monthsBetween(d, new Date(now));
  if (months < 1) return `${stamp}, ${ago(Math.floor(days / 7), "week")}`;
  if (months < 12) return `${stamp}, ${ago(months, "month")}`;
  return `${stamp}, ${ago(Math.floor(months / 12), "year")}`;
}

/**
 * Enforce the three timeline invariants, in this order:
 *
 *   1. nothing is future-dated relative to `now`;
 *   2. slots keep their declared chronological order (oldest slot first);
 *   3. every slot lands strictly after `anchorLastAt`, when there is an anchor.
 *
 * The rebase rule for (3): if the earliest slot would land at or before the anchor,
 * shift the *whole* set forward by one delta so the earliest sits `MIN_GAP_MS` after
 * the anchor. Shifting rather than clamping is the point — the gaps between slots
 * are the shape of the conversation ("she chased three days after the original ask"),
 * and clamping each offending slot separately would flatten them all onto one
 * instant. If that shift would push the newest slot past `now`, there is not enough
 * room left between the anchor and now to hold the real gaps, so compress them
 * proportionally into `[anchor + gap, now]` instead: the intervals shrink, but the
 * order and the relative rhythm survive.
 *
 * Pass `anchorLastAt <= 0` for "no anchor"; (1) and (2) are still applied, so callers
 * have one path either way. Phrases are re-derived from the times this returns, which
 * makes this function the single source of truth for what the composer may quote.
 */
export function rebaseSlots(
  slots: SlotTime[],
  anchorLastAt: number,
  now: number,
): SlotTime[] {
  if (slots.length === 0) return [];

  const times = slots.map((s) => s.at);

  // (2) A scenario listing an older slot after a newer one is a scenario bug, but the
  // fixture still has to read as one conversation, so pull the straggler forward onto
  // its predecessor rather than emitting messages that answer each other backwards.
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) times[i] = times[i - 1];
  }

  // (3) Rebase. `base` is capped at `now` so a wildly recent — or, from a bad sync, a
  // future-dated — anchor can never drag the slots into the future; in that degenerate
  // case everything collapses onto `now`, because a future-dated probe is a worse lie
  // than a probe sharing an instant with the message it answers.
  if (anchorLastAt > 0) {
    const base = Math.min(anchorLastAt + MIN_GAP_MS, now);
    if (times[0] < base) {
      const shift = base - times[0];
      const newest = times[times.length - 1] + shift;
      if (newest <= now) {
        for (let i = 0; i < times.length; i++) times[i] += shift;
      } else {
        const span = times[times.length - 1] - times[0];
        const factor = span > 0 ? (now - base) / span : 0;
        const oldest = times[0];
        for (let i = 0; i < times.length; i++) {
          times[i] = Math.round(base + (times[i] - oldest) * factor);
        }
      }
    }
  }

  // (1) and (2) again: compression rounds, and rounding can put two slots on the same
  // millisecond. Equal is fine — inverted is not.
  let prev = Number.NEGATIVE_INFINITY;
  return slots.map((slot, i) => {
    const at = Math.min(Math.max(times[i], prev), now);
    prev = at;
    return { slotId: slot.slotId, at, phrase: humanPhrase(at, now) };
  });
}

/**
 * Resolve a scenario's slots into absolute times. Split out from the stage so tests
 * can drive it with a fixed clock and a hand-built anchor date, with no `StageCtx`.
 */
export function buildTimeline(
  slots: MessageSlot[],
  anchorLastAt: number | null,
  now: number,
): Timeline {
  const raw: SlotTime[] = slots.map((slot) => {
    const at = now - slot.minutesAgo * MINUTE;
    return { slotId: slot.id, at, phrase: humanPhrase(at, now) };
  });

  // 0 rather than null: `Timeline.anchorLastAt` is a plain number, and 0 is the one
  // value no real `internalDate` takes. Readers test `anchorLastAt > 0`.
  const anchor = anchorLastAt && anchorLastAt > 0 ? anchorLastAt : 0;

  return {
    anchorLastAt: anchor,
    anchorPhrase: anchor ? humanPhrase(anchor, now) : NO_ANCHOR_PHRASE,
    slots: rebaseSlots(raw, anchor, now),
  };
}

export const timelineStage: Stage<TimelineInput, Timeline> = {
  name: "timeline",
  async run(input, ctx) {
    const timeline = buildTimeline(ctx.scenario.slots, input.anchorLastAt, ctx.now);
    const slotSummary = timeline.slots.map((s) => `${s.slotId} ${s.phrase}`).join(", ");
    ctx.say(`dating slots against anchor (${timeline.anchorPhrase}): ${slotSummary}`);
    return timeline;
  },
};
