import { describe, expect, it } from "vitest";
import { NoResemblingExample, nearestTemplate, templateStandIn } from "../app/api/_lib/draft";
import { TEMPLATES } from "../app/api/_lib/templates";

// A SUBSTITUTE COMPANY IS ONLY EVER OFFERED, NEVER HANDED OVER.
//
// The offline fallback had no floor: the scan started at `bestScore = -1`, so a
// brief sharing not one word with any shipped day still came back as
// TEMPLATES[0]. "A nine-person bike repair chain, mid-recall" was answered with
// Northbeam Capital, treasury automation, twelve people, and the only thing the
// screen said was that a template had been used.
//
// The briefs below are the evidence the floor of 2 was chosen from. They are
// written the way the composer asks for them — a company, and what goes wrong
// today — because that is what the matcher will actually be given.

/** Briefs that ARE one of the shipped days, and which one. */
const RESEMBLES: readonly [string, string][] = [
  [
    "A 30-person customer support desk. Checkout has been down since 8am and customers are emailing in while engineering is still fixing it.",
    "outage-comms",
  ],
  [
    "A 20-person design agency on the last day of the quarter. Three invoices are unpaid, one client is disputing scope, and finance needs an answer before close of business.",
    "invoice-chase",
  ],
  [
    "A Series A health startup trying to get a staff engineer candidate through a final loop this week. Two interviewers are double-booked and the candidate has a competing offer expiring Friday.",
    "candidate-scheduling",
  ],
  [
    "A 40-person logistics firm whose COO is flying to a customer site today. Her flight is delayed, two meetings need moving, and a supplier wants a decision before she lands.",
    "travel-day",
  ],
];

/** Businesses none of the five is about. Each one used to come back as a day. */
const RESEMBLES_NOTHING: readonly string[] = [
  "a nine-person bike repair chain, mid-recall",
  "A nine-person bike repair chain in the middle of a safety recall on a brake part. Riders keep turning up at the shops.",
  "A family bakery with three shops. The flour supplier has doubled prices overnight.",
  "A veterinary practice with four vets and a new pet insurance partner.",
  "A karate dojo enrolling kids for the summer term.",
  "A twelve-person organic farm during harvest week.",
];

describe("nearestTemplate", () => {
  it("finds the shipped day a brief actually is", () => {
    for (const [brief, id] of RESEMBLES) {
      const match = nearestTemplate(brief);
      expect(match?.template.id, brief).toBe(id);
      // The words are the whole reason the match was made, so they are carried
      // out with it — a match nobody can audit is the old behaviour with a
      // number on it.
      expect(match?.shared.length, brief).toBeGreaterThanOrEqual(2);
    }
  });

  it("returns nothing for a business none of them is about", () => {
    for (const brief of RESEMBLES_NOTHING) expect(nearestTemplate(brief), brief).toBeNull();
  });

  it("does not count grammar, headcounts or the furniture of a workday", () => {
    // Every word here is in a template's text. None of them says what the
    // business is, and before the filter these three scored the same as
    // "quarter, invoices" did.
    expect(nearestTemplate("A business with three people, this week, at the company")).toBeNull();
  });

  it("treats one word in common as the coincidence it is", () => {
    // "engineering" is the only subject word this shares with the outage day,
    // and a SOC 2 audit is not an outage.
    const audit =
      "A 12-person fintech the week before its SOC 2 audit. This morning the auditor asks for evidence nobody has gathered, and the head of engineering is on a plane.";
    expect(nearestTemplate(audit)).toBeNull();
  });

  it("refuses to break a tie the user is better placed to break", () => {
    // One word from the outage day's text and one from the invoice day's, so
    // both score exactly 1... and both are below the floor. Push both to 2 and
    // the tie itself is the answer: picking by array position is how an
    // unrelated company got chosen in the first place.
    const both = "checkout customers invoices quarter";
    expect(nearestTemplate(both)).toBeNull();
  });
});

describe("templateStandIn", () => {
  const WHY = "OPENROUTER_API_KEY is not set, so no model could be asked";

  it("says which example it substituted, and that it is not the business described", () => {
    const brief = RESEMBLES[0]![0];
    const { draft } = templateStandIn(brief, 12, WHY);
    const template = TEMPLATES.find((t) => t.id === "outage-comms");

    expect(draft.offline).toBe(true);
    const reason = draft.offlineReason ?? "";
    expect(reason).toContain(WHY);
    // All three facts, in the one string the preview prints beside the name:
    // this is not yours, this is which one, and this is why it was picked.
    expect(reason).toContain("not your business");
    expect(reason).toContain(template!.title);
    expect(reason).toContain(template!.scenario.business.name);
    expect(reason).toContain("checkout");
    // The company on screen is the template's, and the brief stays the user's —
    // the preview shows them side by side so the swap cannot be missed.
    expect(draft.business.name).toBe(template!.scenario.business.name);
  });

  it("builds the day at the length that was asked for", () => {
    const { spec, draft } = templateStandIn(RESEMBLES[0]![0], 12, WHY);
    expect(spec.clock.ticks).toBe(12);
    expect(draft.episode.ticks).toBe(12);
  });

  it("hands back nothing rather than an unrelated company", () => {
    for (const brief of RESEMBLES_NOTHING) {
      expect(() => templateStandIn(brief, 12, WHY), brief).toThrow(NoResemblingExample);
    }

    let message = "";
    try {
      templateStandIn(RESEMBLES_NOTHING[0]!, 12, WHY);
    } catch (err) {
      message = (err as Error).message;
    }
    // What the user is owed here is two facts and an offer, not an apology.
    expect(message).toContain(WHY);
    expect(message).toContain("resembles the business you described");
    expect(message).toContain("none was substituted");
    expect(message).toContain("pick one of the shipped days");
  });
});
