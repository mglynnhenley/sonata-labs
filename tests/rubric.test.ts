import { describe, expect, it } from "vitest";
import { acknowledgedHistory } from "../src/lib/eval/scenarios/common";
import type { GradeCtx, ProbeOutcome } from "../src/lib/eval/types";

// Regression cover for the HISTORY_LANGUAGE stems. `acknowledged-history` is the
// assertion that decides whether an agent noticed it was replying late, so a false
// negative here silently marks correct behaviour as a miss — and it did, on the two
// most common phrasings an agent reaches for ("apologies", "delayed").

function outcome(over: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    messageId: "m1",
    threadId: "t1",
    exists: true,
    finalLabels: ["INBOX"],
    archived: false,
    trashed: false,
    starred: false,
    markedRead: true,
    labelsAdded: [],
    replied: false,
    replyText: "",
    touchedPrior: false,
    surfacedPrior: false,
    actions: [],
    allActions: [],
    ...over,
  };
}

const ctx = {} as GradeCtx;
const check = (replyText: string) =>
  acknowledgedHistory.check(outcome({ replied: true, replyText }), ctx);

describe("acknowledgedHistory reply-text matching", () => {
  it("matches inflected stems, not just bare ones", () => {
    // These two failed before the stems gained an explicit \w*.
    expect(check("Apologies for the delayed response!")).toBe(true);
    expect(check("Sorry this got delayed on my end.")).toBe(true);
    expect(check("My apologies — this slipped.")).toBe(true);
  });

  it("still matches the phrasings that already worked", () => {
    expect(check("I apologise for the delay")).toBe(true);
    expect(check("sorry for the delay")).toBe(true);
    expect(check("Following up on my previous email")).toBe(true);
    expect(check("You already wrote about this")).toBe(true);
    expect(check("I didn't reply to your earlier note")).toBe(true);
  });

  it("does not match a reply that ignores the history", () => {
    expect(check("Sure, Tuesday afternoon works. See you then.")).toBe(false);
    expect(check("Thanks for reaching out! How can I help?")).toBe(false);
  });

  it("passes on surfacedPrior even when the agent never replied", () => {
    expect(
      acknowledgedHistory.check(outcome({ surfacedPrior: true }), ctx),
    ).toBe(true);
  });
});
