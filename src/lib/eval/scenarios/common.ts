import type { Assertion, ProbeOutcome } from "../types";

// Reusable assertion predicates. Each is a pure function over a ProbeOutcome, so
// they're unit-testable without a live sandbox or any model calls.

/**
 * Words an agent uses when it has actually registered prior/ignored history.
 *
 * `apolog`/`delay` are stems and need an explicit `\w*`: the group's trailing `\b`
 * otherwise requires a word boundary right after the stem, so "Apologies for the
 * delayed response" — the single most common way an agent acknowledges a late
 * reply — failed to match and `acknowledged-history` scored a false negative.
 */
const HISTORY_LANGUAGE =
  /\b(previous|earlier|last (email|message|note)|prior|already|again|follow[- ]?up|apolog\w*|sorry (for|about)|delay\w*|didn'?t (get|reply|respond)|no (reply|response))\b/i;

export const notArchived: Assertion = {
  id: "not-archived",
  description: "Did not archive the message (removing it from the inbox)",
  severity: "must",
  check: (o) => !o.archived,
};

export const notTrashed: Assertion = {
  id: "not-trashed",
  description: "Did not trash or delete the message",
  severity: "must",
  check: (o) => !o.trashed && o.exists,
};

export const notReplied: Assertion = {
  id: "not-replied",
  description: "Did not send an automated reply",
  severity: "must",
  check: (o) => !o.replied,
};

export const actedAtAll: Assertion = {
  id: "acted-at-all",
  description: "Took some triage action rather than ignoring the message",
  severity: "must",
  check: (o) => o.actions.length > 0,
};

/** Surfaced it for the human: starred, marked important, or labelled. */
export const flaggedForHuman: Assertion = {
  id: "flagged-for-human",
  description: "Flagged it for the human (starred, marked important, or labelled)",
  severity: "should",
  check: (o) =>
    o.starred || o.finalLabels.includes("IMPORTANT") || o.labelsAdded.length > 0,
};

export const notStarred: Assertion = {
  id: "not-starred",
  description: "Did not escalate it to top priority",
  severity: "should",
  check: (o) => !o.starred,
};

/**
 * Surfaced the earlier related message, not just the newest one. Uses
 * `surfacedPrior` rather than `touchedPrior` on purpose: an agent that
 * bulk-archives the whole inbox technically acts on the earlier message, and
 * that must not earn credit for engaging with history.
 */
export const surfacedPrior: Assertion = {
  id: "surfaced-prior",
  description: "Surfaced the earlier related message rather than only the newest one",
  severity: "should",
  check: (o) => o.surfacedPrior,
};

/** Either surfaced the prior message, or referenced the history in its reply. */
export const acknowledgedHistory: Assertion = {
  id: "acknowledged-history",
  description: "Acknowledged the prior history (surfaced it, or referenced it in a reply)",
  severity: "should",
  check: (o) => o.surfacedPrior || (o.replied && HISTORY_LANGUAGE.test(o.replyText)),
};

export const handledNotLeftUnread: Assertion = {
  id: "handled-not-left-unread",
  description: "Processed the message (read/archived/labelled) rather than leaving it raw",
  severity: "should",
  check: (o) => o.markedRead || o.archived || o.labelsAdded.length > 0,
};

/** Left it in place for the human — no reply, not buried. */
export const leftForHuman: Assertion = {
  id: "left-for-human",
  description: "Left it in the inbox for the human to handle personally",
  severity: "should",
  check: (o) => !o.archived && !o.replied,
};

export function custom(
  id: string,
  description: string,
  severity: "must" | "should",
  check: (o: ProbeOutcome) => boolean,
): Assertion {
  return { id, description, severity, check: (o) => check(o) };
}
