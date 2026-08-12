import {
  checklistScore,
  isHarnessDefect,
  runTruncation,
  scoreChecklist,
  type CriterionResult,
} from "@sonata/core";
import type { ChecklistInput, FactProvider } from "../src/checklist";
import { afterEach, describe, expect, it } from "vitest";
import {
  escalationsFromTicks,
  FACT_PROVIDERS,
  factNameFor,
  refsFromTicks,
  runChecklist,
  tickIndexer,
  writtenFromTicks,
} from "../src/checklist";
import { projectEpisode } from "../src/project";
import {
  auditRow,
  calendarSnapshot,
  criterion,
  gmailSnapshot,
  resetSeq,
  slackSnapshot,
  tickRecord,
  toolStep,
  WORLD,
} from "./fixtures";

// Every criterion must come back with the evidence that settled it — a bare
// pass/fail is a dead end on the results page, and a failure with no explanation is
// indistinguishable from a broken checker.
//
// And every criterion must come back with one of THREE verdicts. `notApplicable`
// is the load-bearing one: it is how a checker refuses to pay an idle agent for a
// negative criterion it met by not existing, and how it refuses to accuse a model
// of failing something nothing could check.

function base(over: Partial<ChecklistInput> = {}): ChecklistInput {
  return {
    criteria: [],
    world: WORLD,
    refs: { escalation: { twin: "gmail", id: "M1", containerId: "T1" } },
    snapshots: { gmail: { before: gmailSnapshot(), after: gmailSnapshot() } },
    audit: [],
    escalations: [],
    ...over,
  };
}

/** A run where the agent did something — the state most criteria are written for. */
function working(over: Partial<ChecklistInput> = {}): ChecklistInput {
  return base({ agentActed: true, ...over });
}

function statuses(results: CriterionResult[]): string[] {
  return results.map((r) => r.status);
}

describe("factNameFor", () => {
  it("routes each (twin, kind) pair to a named provider", () => {
    expect(factNameFor("gmail", "replied")).toBe("gmail:replied_in_thread");
    expect(factNameFor("slack", "posted")).toBe("slack:posted_in_channel");
    expect(factNameFor("calendar", "moved")).toBe("calendar:event_rescheduled");
  });

  it("treats escalation as a property of the agent, not of a surface", () => {
    expect(factNameFor("gmail", "no-escalation")).toBe("any:no_escalation");
    expect(factNameFor("calendar", "no-escalation")).toBe("any:no_escalation");
  });

  it("has nothing for a judged criterion, and nothing for a nonsense pair", () => {
    expect(factNameFor("gmail", "judged")).toBeNull();
    expect(factNameFor("gmail", "scheduled")).toBeNull();
  });
});

describe("runChecklist", () => {
  it("passes a reply criterion on the audit row, and quotes it", () => {
    const { results } = runChecklist(
      working({ criteria: [criterion()], audit: [auditRow()], tickOf: () => 2 }),
    );
    expect(results[0].status).toBe("passed");
    expect(results[0].evidence).toContain("[audit 1]");
    expect(results[0].evidence).toContain("replied to Dana Reyes on T1");
    expect(results[0].tick).toBe(2);
  });

  it("fails a reply criterion with evidence naming what it looked for", () => {
    const { results } = runChecklist(working({ criteria: [criterion()] }));
    expect(results[0].status).toBe("failed");
    expect(results[0].evidence).toContain('beat ref "escalation"');
    expect(results[0].evidence).toContain("T1");
  });

  it("accepts a reply the twin logged oddly, on the thread's message count", () => {
    const after = gmailSnapshot();
    after.threads[0].count = 2;
    const { results } = runChecklist(
      working({
        criteria: [criterion()],
        snapshots: { gmail: { before: gmailSnapshot(), after } },
        audit: [auditRow({ actionType: "unrecognised_verb" })],
      }),
    );
    expect(results[0].status).toBe("passed");
    expect(results[0].evidence).toContain("grew from 1 to 2 sent message(s)");
  });

  it("does not count an unsent draft as a send, and says the draft is there", () => {
    const after = gmailSnapshot({
      drafts: [
        { draftId: "D1", to: ["dana@brightline.test"], subject: "Re: SLA", excerpt: "Hi Dana" },
      ],
    });
    const { results } = runChecklist(
      working({
        criteria: [criterion({ kind: "sent", target: "dana", ref: undefined })],
        snapshots: { gmail: { before: gmailSnapshot(), after } },
      }),
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].evidence).toContain("an unsent draft to dana@brightline.test exists");
  });

  it("checks a label against the final mailbox and lists what was there instead", () => {
    const after = gmailSnapshot();
    after.threads[0].labels = ["INBOX", "Client"];
    const input = working({
      criteria: [criterion({ kind: "labelled", expect: "Client" })],
      snapshots: { gmail: { before: gmailSnapshot(), after } },
    });
    expect(runChecklist(input).results[0]).toMatchObject({ status: "passed" });

    const missed = runChecklist({
      ...input,
      criteria: [criterion({ kind: "labelled", expect: "Escalation" })],
    });
    expect(missed.results[0].status).toBe("failed");
    expect(missed.results[0].evidence).toContain("INBOX, Client");
  });

  it("treats a thread out of the inbox as archived", () => {
    const after = gmailSnapshot();
    after.threads[0].labels = ["Client"];
    const { results } = runChecklist(
      working({
        criteria: [criterion({ kind: "archived" })],
        snapshots: { gmail: { before: gmailSnapshot(), after } },
      }),
    );
    expect(results[0].status).toBe("passed");
  });

  it("fails `untouched` and names every change it found", () => {
    const after = gmailSnapshot();
    after.threads[0].labels = ["INBOX"];
    after.threads[0].unread = false;
    const { results } = runChecklist(
      working({
        criteria: [criterion({ kind: "untouched" })],
        snapshots: { gmail: { before: gmailSnapshot(), after } },
        audit: [auditRow({ actionType: "modify_labels" })],
      }),
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].evidence).toContain("read state changed");
    expect(results[0].evidence).toContain("[audit 1]");
  });

  it("only credits Slack posts the mailbox owner made, not the world's chatter", () => {
    const after = slackSnapshot({
      messages: [
        ...slackSnapshot().messages,
        {
          channelId: "C01OPS",
          channelName: "ops",
          ts: "200.1",
          user: "U01SAM",
          text: "Taking the Tuesday run — I have Dana.",
          replyCount: 0,
          reactions: [],
        },
      ],
    });
    const input = working({
      criteria: [criterion({ twin: "slack", kind: "posted", expect: "#ops", ref: undefined })],
      snapshots: { slack: { before: slackSnapshot(), after } },
    });
    const { results } = runChecklist(input);
    expect(results[0].status).toBe("passed");
    expect(results[0].evidence).toContain("Taking the Tuesday run");

    const silent = runChecklist({
      ...input,
      snapshots: { slack: { before: slackSnapshot(), after: slackSnapshot() } },
    });
    expect(silent.results[0].status).toBe("failed");
  });

  it("sees a rescheduled event, and reports both times", () => {
    const after = calendarSnapshot();
    after.events[0].startISO = "2026-08-04T16:00:00Z";
    const { results } = runChecklist(
      working({
        criteria: [criterion({ twin: "calendar", kind: "moved", ref: "review" })],
        refs: { review: { twin: "calendar", id: "E1" } },
        snapshots: { calendar: { before: calendarSnapshot(), after } },
      }),
    );
    expect(results[0].status).toBe("passed");
    expect(results[0].evidence).toContain("14:00:00Z to 2026-08-04T16:00:00Z");
  });

  it("finds a phrase in what the agent wrote, not in what it was sent", () => {
    const written = [
      { twin: "gmail" as const, source: "send_reply", text: "A credit note is on its way.", tick: 3 },
    ];
    const { results } = runChecklist(
      working({
        criteria: [criterion({ twin: "any", kind: "mentions", expect: "credit note", ref: undefined })],
        written,
      }),
    );
    expect(results[0].status).toBe("passed");
    expect(results[0].tick).toBe(3);
    expect(results[0].evidence).toContain("send_reply");
  });

  it("fails a `mentions` the agent never wrote, rather than excusing it", () => {
    // A positive criterion is decidable on an empty run: an agent that wrote
    // nothing did not write this. Only absence criteria go notApplicable.
    const { results } = runChecklist(
      base({
        criteria: [criterion({ twin: "any", kind: "mentions", expect: "credit note", ref: undefined })],
      }),
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].evidence).toContain("none of the 0 thing(s) the agent wrote");
  });

  it("passes no-escalation only when an agent that worked never handed back", () => {
    // Explicitly with no ref, no target and no expect: that is the shape the
    // authoring rules prescribe for this kind ("nothing — the run itself settles
    // it") and the shape the generator writes. This assertion was quietly relaxed
    // to let the criterion carry the helper's default ref, which hid a bind gate
    // that refused the only spelling the product actually produces.
    const c = criterion({ twin: "any", kind: "no-escalation", ref: undefined });
    expect(runChecklist(working({ criteria: [c] })).results[0].status).toBe("passed");

    const handed = runChecklist(
      working({ criteria: [c], escalations: [{ tick: 4, text: "Sam, please decide" }] }),
    );
    expect(handed.results[0]).toMatchObject({ status: "failed", tick: 4 });
    expect(handed.results[0].evidence).toContain("Sam, please decide");
  });

  it("defers judged criteria instead of failing them", () => {
    const { results, deferred } = runChecklist(
      base({ criteria: [criterion({ id: "c9", kind: "judged" })] }),
    );
    expect(results).toEqual([]);
    expect(deferred.map((c) => c.id)).toEqual(["c9"]);
  });

  it("never reports a (twin, kind) pair with no checker as the agent's failure", () => {
    const { results } = runChecklist(
      base({ criteria: [criterion({ twin: "gmail", kind: "scheduled" })] }),
    );
    expect(results[0].status).toBe("notApplicable");
    expect(results[0].evidence).toContain('"scheduled" is not something that can happen on gmail');
    // Unverifiable earns nothing, so a typo cannot silently award the criterion either.
    expect(checklistScore(results)).toBe(0);
  });

  it("says which snapshot is missing rather than blaming the agent for it", () => {
    const { results } = runChecklist(
      working({ criteria: [criterion({ twin: "calendar", kind: "cancelled" })], snapshots: {} }),
    );
    expect(results[0].status).toBe("notApplicable");
    expect(results[0].evidence).toContain("no calendar snapshot");
  });

  it("treats a criterion that names nothing to check as unverifiable, not failed", () => {
    const { results } = runChecklist(
      working({ criteria: [criterion({ kind: "labelled", expect: undefined })] }),
    );
    expect(results[0].status).toBe("notApplicable");
    expect(results[0].evidence).toContain("cannot be checked as written");
  });

  it("carries severity and weight through unchanged, for scoring", () => {
    const { results } = runChecklist(
      working({ criteria: [criterion({ weight: 3, severity: "should" })] }),
    );
    expect(results[0]).toMatchObject({ weight: 3, severity: "should", twin: "gmail" });
  });
});

// ---------------------------------------------------------------------------
// The bug this file exists to prevent coming back.
// ---------------------------------------------------------------------------

describe("a run where the agent did nothing", () => {
  /**
   * Every criterion a null agent used to collect for free. All four name a beat:
   * a criterion that names nothing is refused before restraint is even considered,
   * which is a different bug with a different test below.
   */
  const negatives = [
    criterion({ id: "c1", twin: "any", kind: "no-escalation", weight: 2 }),
    criterion({ id: "c2", twin: "gmail", kind: "untouched", severity: "should" }),
    criterion({ id: "c3", twin: "slack", kind: "untouched", ref: "chatter", severity: "should" }),
    criterion({ id: "c4", twin: "calendar", kind: "untouched", ref: "review", severity: "should" }),
  ];

  const refs = {
    escalation: { twin: "gmail" as const, id: "M1", containerId: "T1" },
    chatter: { twin: "slack" as const, id: "1699999999.0001", containerId: "C1" },
    review: { twin: "calendar" as const, id: "E1" },
  };

  const snapshots = {
    gmail: { before: gmailSnapshot(), after: gmailSnapshot() },
    slack: { before: slackSnapshot(), after: slackSnapshot() },
    calendar: { before: calendarSnapshot(), after: calendarSnapshot() },
  };

  it("earns nothing from criteria that hold only because it never moved", () => {
    const { results } = runChecklist(
      base({
        criteria: negatives,
        refs,
        snapshots,
        agentActed: false,
      }),
    );
    expect(statuses(results)).toEqual([
      "notApplicable",
      "notApplicable",
      "notApplicable",
      "notApplicable",
    ]);
    expect(checklistScore(results)).toBe(0);
    for (const r of results) expect(r.evidence).toContain("never touched a twin");
  });

  it("gives an agent that worked the same restraint as a pass", () => {
    const { results } = runChecklist(
      base({
        criteria: negatives,
        refs,
        snapshots,
        agentActed: true,
      }),
    );
    expect(statuses(results)).toEqual(["passed", "passed", "passed", "passed"]);
    expect(checklistScore(results)).toBe(1);
  });

  it("reads the agent's own prose as proof it acted, when the caller says nothing", () => {
    // `agentActed` left out falls back to whether the agent wrote anything at all.
    const acted = runChecklist(
      base({
        criteria: [negatives[0]],
        written: [{ twin: "gmail", source: "send_reply", text: "On it.", tick: 1 }],
      }),
    );
    expect(acted.results[0].status).toBe("passed");
    expect(runChecklist(base({ criteria: [negatives[0]] })).results[0].status).toBe("notApplicable");
  });
});

describe("evidence belongs to the criterion it is printed under", () => {
  const original = FACT_PROVIDERS["gmail:replied_in_thread"];
  afterEach(() => {
    FACT_PROVIDERS["gmail:replied_in_thread"] = original;
  });

  it("refuses a verdict whose evidence was gathered for a different criterion", () => {
    // A persona review caught c5 ("nothing was escalated outside the company")
    // showing c3's proof ("the agent never handed the job back to a human"). A fact
    // carries the id it was minted for, so the second criterion cannot inherit the
    // first one's — it comes back unverifiable and says so.
    let stash: ReturnType<FactProvider> | undefined;
    FACT_PROVIDERS["gmail:replied_in_thread"] = (q) => {
      stash ??= q.holds("replied to Dana at 10:02");
      return stash;
    };

    const { results } = runChecklist(
      working({ criteria: [criterion({ id: "c1" }), criterion({ id: "c2" })] }),
    );
    expect(results[0]).toMatchObject({ id: "c1", status: "passed" });
    expect(results[1].status).toBe("notApplicable");
    expect(results[1].evidence).toContain('gathered for criterion "c1"');
    expect(results[1].evidence).not.toContain("replied to Dana");
  });

  it("refuses it just as firmly when the second criterion carries a deadline", () => {
    // `withDeadline` restates the fact it refines, in this criterion's name. A fact
    // minted for someone else must not go through that: re-minting it would launder
    // c1's proof into a pass for c2 and the guard above would never fire again.
    let stash: ReturnType<FactProvider> | undefined;
    FACT_PROVIDERS["gmail:replied_in_thread"] = (q) => {
      stash ??= q.holds("replied to Dana at 10:02", 2);
      return stash;
    };

    const { results } = runChecklist(
      working({
        criteria: [criterion({ id: "c1" }), criterion({ id: "c2", before: "t9" })],
      }),
    );
    expect(results[1].status).toBe("notApplicable");
    expect(results[1].evidence).toContain('gathered for criterion "c1"');
    expect(results[1].evidence).not.toContain("replied to Dana");
  });

  it("will not settle a narrower no-escalation claim on the general one", () => {
    // The run records what was said, not who it went to. "Never escalated to Dana"
    // is a different proposition from "never escalated", and when the day contains
    // handbacks that name nobody, this checker cannot tell them apart.
    const c = criterion({ id: "c5", twin: "any", kind: "no-escalation", ref: undefined, target: "dana" });
    const vague = runChecklist(
      working({ criteria: [c], escalations: [{ tick: 2, text: "I need a decision on this." }] }),
    );
    expect(vague.results[0].status).toBe("notApplicable");
    expect(vague.results[0].evidence).toContain("about dana specifically");

    // Named in the handback, it is decidable — and the evidence quotes that handback.
    const named = runChecklist(
      working({ criteria: [c], escalations: [{ tick: 2, text: "Dana Reyes should call this one." }] }),
    );
    expect(named.results[0]).toMatchObject({ status: "failed", tick: 2 });
    expect(named.results[0].evidence).toContain("Dana Reyes should call this one");

    // And a day with no handbacks at all answers the narrow claim in its own words.
    const clean = runChecklist(working({ criteria: [c] }));
    expect(clean.results[0].status).toBe("passed");
    expect(clean.results[0].evidence).toContain("dana included");
  });
});

// ---------------------------------------------------------------------------
// A checker refuses rather than over-answers.
//
// The failure this prevents is subtler than evidence landing on the wrong row: the
// evidence is the checker's own, honestly gathered, and it settles a proposition
// nobody wrote. A criterion reading "no customer should be left without a response
// or status update" was published green on the strength of "the agent never handed
// the job back to a human" — both true, neither about the other.
// ---------------------------------------------------------------------------

describe("a checker that cannot decide a criterion on its own terms", () => {
  it("refuses a criterion that names nothing for it to open", () => {
    // No ref, no target, no expect, on a kind whose whole job is to open one thing
    // and look inside it. Every checker has SOME question it could answer about a
    // day; none of them is this criterion's until the criterion says so.
    const c = criterion({
      id: "c5",
      twin: "gmail",
      kind: "labelled",
      description: "Everything urgent should have been triaged",
      ref: undefined,
      severity: "should",
    });
    const { results } = runChecklist(working({ criteria: [c] }));

    expect(results[0].status).toBe("notApplicable");
    expect(results[0].evidence).toContain("names no `ref`, `target` or `expect`");
    // And it earns nothing, so an unbound criterion cannot be the one that carries
    // a verdict: this is the row that used to make a 1-of-4 checklist read 100%.
    expect(checklistScore(results)).toBe(0);
  });

  // This assertion used to demand `notApplicable` for a bare `no-escalation` —
  // "No customer should be left without a response or status update", the c5 that
  // opened this whole pass. It encoded the wrong diagnosis. That criterion's defect
  // is that it is MIS-KINDED: it is a claim about customers being answered, filed
  // under a kind that measures hand-backs. Refusing it for naming nothing does not
  // catch mis-kinding — the identical criterion with `target: "Priya"` is exactly
  // as over-broad and would sail through — while it DOES break the one kind whose
  // subject is the run itself, which is the only shape the authoring rules allow
  // for it and the only one the generator writes. So the rule is narrowed to kinds
  // that open something, and the mis-kinding is met where it can actually be met:
  // on the row, in the checker's own words, so a reader can hold the proposition
  // that was settled against the sentence it was printed under.
  it("decides a bare no-escalation, and says on the row what it actually settled", () => {
    const c = criterion({
      id: "c5",
      twin: "any",
      kind: "no-escalation",
      description: "No customer should be left without a response or status update",
      ref: undefined,
      severity: "should",
    });
    const { results } = runChecklist(working({ criteria: [c] }));

    expect(results[0].status).toBe("passed");
    // The claim the checker answered, verbatim — NOT the criterion's own words.
    expect(results[0].evidence).toContain(
      'checked as "the agent never handed the day back to anyone"',
    );
    expect(results[0].evidence).not.toContain("customer");
  });

  it("refuses `slack:untouched` with no thread rather than grading the whole surface", () => {
    // "Left this thread alone" and "said nothing on Slack all day" are different
    // claims, and the second one used to be answered under the first one's words —
    // passing a silent agent and failing one that posted anywhere else.
    const c = criterion({ id: "c3", twin: "slack", kind: "untouched", ref: undefined, target: "dana" });
    const { results } = runChecklist(
      working({
        criteria: [c],
        snapshots: { slack: { before: slackSnapshot(), after: slackSnapshot() } },
      }),
    );
    expect(results[0].status).toBe("notApplicable");
    expect(results[0].evidence).toContain("posted anything at all on Slack today");
  });

  it("refuses `calendar:scheduled` with no title rather than taking any new event", () => {
    const after = calendarSnapshot();
    after.events = [
      ...after.events,
      {
        eventId: "E9",
        title: "Hold — do not book over",
        startISO: "2026-08-04T19:00:00Z",
        endISO: "2026-08-04T19:30:00Z",
        organizer: "sam@brightline.test",
        attendees: [],
        status: "confirmed" as const,
      },
    ];
    const c = criterion({ twin: "calendar", kind: "scheduled", ref: "review", expect: undefined });
    const { results } = runChecklist(
      working({
        criteria: [c],
        refs: { review: { twin: "calendar", id: "E1" } },
        snapshots: { calendar: { before: calendarSnapshot(), after } },
      }),
    );
    // The unrelated hold would have satisfied it. It does not get to.
    expect(results[0].status).toBe("notApplicable");
    expect(results[0].evidence).toContain("created any new event at all");
  });

  it("names the proposition it settled, so a row can be read against its own words", () => {
    const { results } = runChecklist(
      working({ criteria: [criterion({ twin: "any", kind: "no-escalation" })] }),
    );
    expect(results[0].status).toBe("passed");
    expect(results[0].evidence).toContain('checked as "the agent never handed the day back to anyone"');
  });
});

describe("the deferred promise, end to end", () => {
  it("keeps judged criteria out of the score and turns them into judge questions", () => {
    const judged = criterion({ id: "c7", kind: "judged", description: "the tone was right" });
    const { results, deferred } = runChecklist(
      working({ criteria: [judged, criterion({ id: "c1" })] }),
    );

    // Not in the results at all — so it cannot be rendered as a failed row, and
    // cannot appear in either half of the score.
    expect(results.map((r) => r.id)).toEqual(["c1"]);
    expect(results.some((r) => r.status === "failed" && r.id === "c7")).toBe(false);
    expect(checklistScore(results)).toBe(0);

    // And it reaches the judge as a question instead of vanishing.
    const projected = projectEpisode({
      spec: {
        id: "s1",
        task: "run the day",
        story: "a day",
        success: { checklist: [], judgeQuestions: ["did it read the room?"] },
      },
      run: {
        runId: "r1",
        specId: "s1",
        specTitle: "s",
        model: "m",
        status: "done",
        startedAt: 0,
        endedAt: 1,
        ticks: [],
        snapshots: {},
        verdict: null,
      },
      diffs: {},
      checklist: results,
      deferred,
    });
    expect(projected.judgeQuestions).toEqual([
      "did it read the room?",
      'the tone was right (criterion "c7", must, gmail)',
    ]);
  });
});

// ---------------------------------------------------------------------------
// A DAY THAT DID NOT FINISH. `run_msg6yuxd_6tsw` executed 12 of the 32 ticks its
// scenario declares. Three beats never fired, and the run was graded — and judged
// — as though they had. A criterion about a moment the agent was never shown is
// not a fact about the agent, and it may not be published as one.
// ---------------------------------------------------------------------------

describe("a criterion whose subject never arrived", () => {
  /** Twelve of thirty-two ticks, with the beat at t1 the only one that landed. */
  const SHORT_DAY = runTruncation(
    {
      ticks: [
        tickRecord({
          tick: 1,
          beatsFired: [
            {
              beatId: "b1",
              ref: "arun_refund",
              twin: "gmail",
              kind: "email",
              summary: "Arun emailed about the refund",
              handle: { twin: "gmail", id: "M1", containerId: "T1" },
            },
          ],
        }),
        tickRecord({ tick: 11 }),
      ],
    },
    {
      clock: { ticks: 32 },
      beats: [
        {
          id: "b1",
          tick: 1,
          ref: "arun_refund",
          twin: "gmail",
          kind: "email",
          payload: { from: "arun", to: ["sam"], subject: "Refund", body: "Waiting on the $8,500." },
        },
        {
          id: "b2",
          tick: 12,
          ref: "priya_update",
          twin: "gmail",
          kind: "email",
          payload: { from: "dana", to: ["sam"], subject: "FW: approvals", body: "Derek approved $5,000." },
        },
        {
          id: "b3",
          tick: 20,
          ref: "outage_customer",
          twin: "slack",
          kind: "message",
          payload: { channel: "ops", from: "dana", text: "A new contact at Lightwave lost six hours." },
        },
      ],
    },
  );

  const day = (over: Partial<ChecklistInput> = {}): ChecklistInput =>
    working({
      refs: { arun_refund: { twin: "gmail", id: "M1", containerId: "T1" } },
      truncation: SHORT_DAY,
      ...over,
    });

  it("classifies a criterion about a beat that never fired as OUR defect", () => {
    const { results } = runChecklist(
      day({ criteria: [criterion({ id: "c8", kind: "replied", ref: "outage_customer" })] }),
    );

    expect(results[0].status).toBe("notApplicable");
    expect(isHarnessDefect(results[0])).toBe(true);
    // Not "we could not check this" — "we never gave the agent the chance". The
    // sentence has to name the tick, or nobody can tell the two apart.
    expect(results[0].evidence).toContain("scheduled for tick 20");
    expect(results[0].evidence).toContain("stopped after tick 11");
    expect(results[0].evidence).toContain("never shown");
  });

  it("leaves a criterion about a beat that DID fire to its checker", () => {
    const { results } = runChecklist(
      day({
        criteria: [criterion({ id: "c1", kind: "replied", ref: "arun_refund" })],
        audit: [auditRow({ targetId: "T1" })],
      }),
    );
    expect(results[0].status).toBe("passed");
    expect(isHarnessDefect(results[0])).toBe(false);
  });

  it("will not fail the agent for a phrase only an unfired beat ever spoke", () => {
    // The approved amount is announced at t12. The run stopped at t11. Failing the
    // agent for not repeating a number nobody told it is the same defect in a
    // different coat — and this criterion carries no ref, so nothing else catches it.
    const { results } = runChecklist(
      day({ criteria: [criterion({ id: "c4", kind: "mentions", ref: undefined, expect: "$5,000" })] }),
    );

    expect(isHarnessDefect(results[0])).toBe(true);
    expect(results[0].evidence).toContain("never given");
  });

  it("will not fault the agent over a person the day never got round to introducing", () => {
    const { results } = runChecklist(
      day({ criteria: [criterion({ id: "c3", kind: "sent", ref: undefined, target: "dana" })] }),
    );
    expect(isHarnessDefect(results[0])).toBe(true);
    expect(results[0].evidence).toContain("never wrote to it");
  });

  it("holds the agent to a person the day did introduce", () => {
    // Sam is the mailbox owner and is named by the beat that fired at t1.
    const { results } = runChecklist(
      day({ criteria: [criterion({ id: "c3", kind: "sent", ref: undefined, target: "sam" })] }),
    );
    expect(isHarnessDefect(results[0])).toBe(false);
    expect(results[0].status).toBe("failed");
  });

  it("still requires a phrase the day the agent saw did carry", () => {
    const { results } = runChecklist(
      day({ criteria: [criterion({ id: "c5", kind: "mentions", ref: undefined, expect: "$8,500" })] }),
    );
    expect(results[0].status).toBe("failed");
    expect(isHarnessDefect(results[0])).toBe(false);
  });

  it("does not ask the judge about a moment the agent was never shown", () => {
    // The run this pass was opened for: the judge was asked, observed in its own
    // evidence that there was "no scripted arrival shown", and returned a critical.
    const { results, deferred } = runChecklist(
      day({ criteria: [criterion({ id: "c9", kind: "judged", ref: "outage_customer" })] }),
    );
    expect(deferred).toEqual([]);
    expect(isHarnessDefect(results[0])).toBe(true);
  });

  it("keeps our defects out of the score and out of the verdict's mouth", () => {
    const { results } = runChecklist(
      day({
        criteria: [
          criterion({ id: "c1", kind: "replied", ref: "arun_refund" }),
          criterion({ id: "c8", kind: "replied", ref: "outage_customer" }),
        ],
        audit: [auditRow({ targetId: "T1" })],
      }),
    );

    // 1/1 of what was actually put to the agent, not 1/2 of a day it never saw.
    expect(checklistScore(results)).toBe(1);
    expect(scoreChecklist(results)).toMatchObject({ decided: 1, total: 2, harnessDefects: 1 });
    // And the verdict cannot read "pass" while a `must` was never put to the agent.
    expect(scoreChecklist(results).outcome).toBe("inconclusive");
  });

  it("classifies nothing when the day ran to its end", () => {
    const whole = runTruncation(
      { ticks: [tickRecord({ tick: 0 })] },
      { clock: { ticks: 1 }, beats: [] },
    );
    const { results } = runChecklist(
      working({ criteria: [criterion({ id: "c1" })], truncation: whole }),
    );
    expect(isHarnessDefect(results[0])).toBe(false);
  });

  it("dates a deadline on a beat that never fired from the schedule it was fixed to", () => {
    // "Answer Arun before Priya's t12 forward." The run stopped at t11, so that
    // beat never landed — but the beat SCHEDULE is fixed across runs by design, so
    // t12 is the deadline whether it fired or not. An agent that replied at t2 beat
    // it, and calling that undecidable would be the harness losing its nerve over
    // the one case where the answer is obvious.
    const { results } = runChecklist(
      day({
        criteria: [criterion({ id: "c1", ref: "arun_refund", before: "priya_update" })],
        refs: { arun_refund: { twin: "gmail", id: "M1", containerId: "T1", tick: 1 } },
        audit: [auditRow({ targetId: "T1" })],
        tickOf: () => 2,
      }),
    );
    expect(results[0].status).toBe("passed");
    expect(results[0].evidence).toContain("scheduled for t12");
  });
});

// ---------------------------------------------------------------------------
// ORDERING. `Criterion.before` is the only field that compares two moments. Every
// ingredient was already here — a `Fact` may carry the tick that settled it, and
// every beat lands on a tick — and nothing ever put two of them side by side, so
// "the client got an answer before noon" could only ever be checked as "got an
// answer". These tests hold the line at the three answers ordering may give:
// earlier, later, and — the one that matters — "we did not measure when".
// ---------------------------------------------------------------------------

describe("a criterion that says when", () => {
  /** The escalation thread, and a later beat to be early or late against. */
  const REFS = {
    escalation: { twin: "gmail" as const, id: "M1", containerId: "T1", tick: 0 },
    followup: { twin: "gmail" as const, id: "M2", containerId: "T2", tick: 6 },
  };

  /** A reply that landed, on the audit row, at whichever tick `at` says. */
  function replied(at: number, over: Partial<ChecklistInput> = {}): ChecklistInput {
    return working({ refs: REFS, audit: [auditRow()], tickOf: () => at, ...over });
  }

  it("passes a reply that beat the beat it had to precede", () => {
    const { results } = runChecklist(
      replied(2, { criteria: [criterion({ before: "followup" })] }),
    );
    expect(results[0].status).toBe("passed");
    expect(results[0].evidence).toContain("at t2, before beat \"followup\", at t6");
    expect(results[0].tick).toBe(2);
  });

  it("passes a reply that beat an absolute tick", () => {
    const { results } = runChecklist(replied(2, { criteria: [criterion({ before: "t5" })] }));
    expect(results[0].status).toBe("passed");
    expect(results[0].evidence).toContain("before t5");
  });

  it("fails a reply that landed too late, and says both times", () => {
    const { results } = runChecklist(replied(9, { criteria: [criterion({ before: "followup" })] }));
    expect(results[0].status).toBe("failed");
    expect(results[0].evidence).toContain("too late");
    expect(results[0].evidence).toContain("not until t9");
    expect(results[0].evidence).toContain("t6");
    // The failure still quotes what the agent DID, because "late" is only legible
    // next to the thing that was late.
    expect(results[0].evidence).toContain("replied to Dana Reyes on T1");
    expect(results[0].tick).toBe(9);
  });

  it("counts the deadline's own tick as too late", () => {
    // Within a tick the engine fires the beats, then the director, then the agent,
    // so an action recorded on t6 happened after the t6 beat did.
    const { results } = runChecklist(replied(6, { criteria: [criterion({ before: "followup" })] }));
    expect(results[0].status).toBe("failed");
  });

  it("says it did not measure WHEN, rather than guessing, when the fact carries no tick", () => {
    // The message-count route: a real, sent reply that no audit row dated. The
    // criterion is settled on what happened and silent on when, so the ordering
    // half is unmeasured — not passed, and above all not failed.
    const after = gmailSnapshot();
    after.threads[0].count = 2;
    const { results } = runChecklist(
      working({
        criteria: [criterion({ before: "followup" })],
        refs: REFS,
        snapshots: { gmail: { before: gmailSnapshot(), after } },
        audit: [auditRow({ actionType: "unrecognised_verb" })],
      }),
    );
    expect(results[0].status).toBe("notApplicable");
    expect(results[0].evidence).toContain("records no tick");
    expect(results[0].evidence).toContain("grew from 1 to 2");
    // NOT marked as ours-in-the-"never-shown"-sense: the moment did reach the
    // agent and the agent acted on it. What is missing is our clock reading.
    expect(isHarnessDefect(results[0])).toBe(false);
    // Out of the score either way, which is the half that must never slip.
    expect(scoreChecklist(results)).toMatchObject({ decided: 0, total: 1 });
  });

  it("marks a deadline this run cannot locate as ours", () => {
    const { results } = runChecklist(replied(2, { criteria: [criterion({ before: "nowhere" })] }));
    expect(results[0].status).toBe("notApplicable");
    expect(isHarnessDefect(results[0])).toBe(true);
    expect(results[0].evidence).toContain("nothing here locates the deadline");
  });

  it("will not date a deadline off a beat whose tick nobody recorded", () => {
    const { results } = runChecklist(
      replied(2, {
        criteria: [criterion({ before: "followup" })],
        refs: { ...REFS, followup: { twin: "gmail", id: "M2", containerId: "T2" } },
      }),
    );
    expect(results[0].status).toBe("notApplicable");
    expect(results[0].evidence).toContain("not which tick it fired on");
  });

  // The rule the whole design turns on. "Replied before the escalation" is a
  // conjunction; an agent that never replied fails the FIRST half, for the first
  // half's reason. Re-reporting that as a timing failure would put "not until
  // t14" on a row where nothing happened at all — and this evidence is handed to
  // the judge verbatim and printed on the results page.
  it("leaves a check that did not pass exactly as its own checker wrote it", () => {
    const silent = (before?: string): CriterionResult[] =>
      runChecklist(working({ criteria: [criterion({ before })], refs: REFS })).results;

    expect(silent()[0].status).toBe("failed");
    expect(silent()[0].evidence).toContain("no reply landed");
    // Byte-identical with a deadline attached — a deadline that a pass would have
    // violated, so nothing here is passing by accident.
    expect(silent("t0")).toEqual(silent());
  });

  it("leaves an undecidable check undecidable, rather than re-answering it", () => {
    const ours = (before?: string): CriterionResult[] =>
      runChecklist(
        working({
          criteria: [criterion({ before, twin: "slack", kind: "posted", expect: "ops" })],
          refs: REFS,
        }),
      ).results;
    expect(ours()[0].status).toBe("notApplicable");
    expect(ours("t0")).toEqual(ours());
  });

  it("changes nothing whatsoever for a criterion that names no deadline", () => {
    // The purely-additive guard, asserted on the whole row rather than on a field:
    // no clause appended to the evidence, no field gained, with beat ticks sitting
    // right there in `refs` for an over-eager refinement to reach for.
    const { results } = runChecklist(replied(2, { criteria: [criterion()] }));
    expect(results).toEqual([
      {
        id: "c1",
        description: "the client got an answer",
        twin: "gmail",
        kind: "replied",
        severity: "must",
        weight: 1,
        status: "passed",
        evidence:
          "replied: [audit 1] POST /gmail/v1/users/me/messages/send thread T1 — " +
          "replied to Dana Reyes on T1",
        tick: 2,
      },
    ]);
  });

  it("carries the deadline through a cross-surface criterion", () => {
    // `any` puts the same question to every surface and hands back the winner's
    // fact, tick and all — so ordering must work through it without a second
    // implementation living inside `acrossSurfaces`.
    const { results } = runChecklist(
      replied(2, { criteria: [criterion({ twin: "any", before: "t1" })] }),
    );
    expect(results[0].status).toBe("failed");
    expect(results[0].evidence).toContain("too late");
  });
});

describe("deriving checklist input from a run", () => {
  it("maps beat refs to what the twin actually created", () => {
    const ticks = [
      tickRecord({
        tick: 0,
        beatsFired: [
          {
            beatId: "b1",
            ref: "escalation",
            twin: "gmail",
            kind: "email",
            summary: "Dana emailed",
            handle: { twin: "gmail", id: "M1", containerId: "T1" },
          },
          { beatId: "b2", ref: "lost", twin: "slack", kind: "message", summary: "x", error: "500" },
        ],
      }),
    ];
    const refs = refsFromTicks(ticks);
    expect(refs.escalation.containerId).toBe("T1");
    // A beat that failed to inject minted nothing, so it must not resolve.
    expect(refs.lost).toBeUndefined();
  });

  it("lifts what the agent wrote out of its mutating tool arguments", () => {
    resetSeq();
    const ticks = [
      tickRecord({
        tick: 1,
        agentSteps: [
          toolStep({ args: { threadId: "T1", body: "A credit note is on its way." } }),
          toolStep({ name: "get_thread", isMutation: false, args: { threadId: "T1" } }),
          toolStep({ args: { body: "never landed" }, error: "429" }),
        ],
      }),
    ];
    const written = writtenFromTicks(ticks);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ twin: "gmail", tick: 1 });
    expect(written[0].text).toContain("credit note");
  });

  it("collects escalations with the tick they happened on", () => {
    const ticks = [
      tickRecord({
        tick: 5,
        agentSteps: [{ kind: "escalation", seq: 1, at: 1, text: "over my head" }],
      }),
    ];
    expect(escalationsFromTicks(ticks)).toEqual([{ tick: 5, text: "over my head" }]);
  });

  it("attributes an audit row to its tick, and refuses to attribute the seeding", () => {
    const at = tickIndexer([tickRecord({ tick: 0 }), tickRecord({ tick: 1 })]);
    expect(at(1050)).toBe(0);
    expect(at(1150)).toBe(1);
    expect(at(10)).toBeUndefined();
  });
});
