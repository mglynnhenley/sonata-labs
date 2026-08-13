import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  CalendarSnapshot,
  Clock,
  EpisodeRun,
  GmailSnapshot,
  SlackSnapshot,
} from "@sonata/core";
import { beforeEach, describe, expect, it } from "vitest";
import { buildFinalState, buildTimeline, buildTrace, projectEpisode } from "../src/project";
import {
  calendarSnapshot,
  directorEvent,
  gmailSnapshot,
  resetSeq,
  slackSnapshot,
  tickRecord,
  toolStep,
} from "./fixtures";

// Projection is the only path by which a run reaches the judge, so the thing worth
// testing is what it refuses to pass through: unbounded results, unbounded prose,
// and pasted email bodies masquerading as timeline rows.

function run(over: Partial<EpisodeRun> = {}): EpisodeRun {
  return {
    runId: "run-1",
    specId: "spec-1",
    specTitle: "Client escalates",
    model: "anthropic/claude-haiku-4.5",
    status: "done",
    startedAt: 1000,
    endedAt: 2000,
    ticks: [],
    snapshots: { gmail: { before: gmailSnapshot(), after: gmailSnapshot() } },
    verdict: null,
    ...over,
  };
}

describe("buildTrace", () => {
  beforeEach(resetSeq);

  it("bounds a runaway tool result to a signal, not a payload", () => {
    const ticks = [
      tickRecord({ tick: 0, agentSteps: [toolStep({ resultSummary: "x".repeat(5000) })] }),
    ];
    const [step] = buildTrace(ticks).steps;
    expect(step.resultSummary.length).toBeLessThanOrEqual(300);
    expect(step.resultSummary.endsWith("…")).toBe(true);
  });

  it("keeps tool arguments verbatim — tone is only judgeable from what was written", () => {
    const body = "Dana, ".concat("we are genuinely sorry about this. ".repeat(40));
    const ticks = [tickRecord({ tick: 0, agentSteps: [toolStep({ args: { body } })] })];
    expect(buildTrace(ticks).steps[0].args).toEqual({ body });
  });

  it("bounds agent prose", () => {
    const ticks = [
      tickRecord({
        tick: 0,
        agentSteps: [{ kind: "thought", seq: 1, at: 1, text: "y".repeat(9000) }],
      }),
    ];
    expect(buildTrace(ticks).turns[0].text.length).toBeLessThanOrEqual(2000);
  });

  it("splits steps, thoughts and escalations, tagging each with its tick", () => {
    resetSeq();
    const ticks = [
      tickRecord({
        tick: 3,
        agentSteps: [
          { kind: "thought", seq: 1, at: 1, text: "Dana is waiting." },
          toolStep(),
          { kind: "escalation", seq: 3, at: 3, text: "Sam, can you confirm?" },
        ],
      }),
    ];
    const trace = buildTrace(ticks, "  I answered Dana.  ");
    expect(trace.steps).toHaveLength(1);
    expect(trace.turns[0]).toMatchObject({ tick: 3, text: "Dana is waiting." });
    expect(trace.escalations[0]).toMatchObject({ tick: 3, text: "Sam, can you confirm?" });
    expect(trace.agentSummary).toBe("I answered Dana.");
  });

  it("drops an empty thought rather than emitting a blank turn", () => {
    const ticks = [
      tickRecord({ tick: 0, agentSteps: [{ kind: "thought", seq: 1, at: 1, text: "   " }] }),
    ];
    expect(buildTrace(ticks).turns).toEqual([]);
  });

  it("omits agentSummary entirely when the agent gave none", () => {
    expect(buildTrace([tickRecord()], "   ").agentSummary).toBeUndefined();
  });
});

describe("buildTimeline", () => {
  beforeEach(resetSeq);

  it("orders each tick as the engine runs it: world, then agent, then reaction", () => {
    const ticks = [
      tickRecord({
        tick: 2,
        beatsFired: [{ beatId: "b1", twin: "gmail", kind: "email", summary: "Dana emailed" }],
        agentSteps: [toolStep()],
        directorEvents: [directorEvent({ becauseSeq: 1 })],
      }),
    ];
    expect(buildTimeline(ticks).map((e) => e.source)).toEqual(["world", "agent", "director"]);
  });

  it("bounds a row so a pasted email cannot become the timeline", () => {
    const ticks = [
      tickRecord({
        tick: 0,
        beatsFired: [{ beatId: "b1", twin: "gmail", kind: "email", summary: "z".repeat(4000) }],
      }),
    ];
    expect(buildTimeline(ticks)[0].text.length).toBeLessThanOrEqual(240);
  });

  it("says on the row itself that a failed write changed nothing", () => {
    const ticks = [
      tickRecord({ tick: 0, agentSteps: [toolStep({ error: "429 rate limited" })] }),
    ];
    expect(buildTimeline(ticks)[0].text).toContain("nothing changed");
  });

  it("keeps thoughts out of the record of what happened", () => {
    const ticks = [
      tickRecord({ tick: 0, agentSteps: [{ kind: "thought", seq: 1, at: 1, text: "hmm" }] }),
    ];
    expect(buildTimeline(ticks)).toEqual([]);
  });

  it("renders a director event on any surface without losing who or why", () => {
    const ticks = [
      tickRecord({ tick: 1, directorEvents: [directorEvent({ reason: "Dana pushes back" })] }),
    ];
    const [row] = buildTimeline(ticks);
    expect(row.source).toBe("director");
    expect(row.text).toContain("That is not good enough.");
    expect(row.text).toContain("[Dana pushes back]");
  });

  // The timeline is the only projection of a run that reaches the judge, so it is
  // also the only route by which what a character concluded can get there.
  it("carries a speaker's own view of the agent through to the judge's input", () => {
    const assessment = { personId: "dana", satisfied: "partly", missing: "the credit" } as const;
    const ticks = [tickRecord({ tick: 1, directorEvents: [directorEvent({ assessment })] })];
    expect(buildTimeline(ticks)[0].assessment).toEqual(assessment);
  });

  it("carries one off a beat the sender reworded, which is the other way to speak", () => {
    const assessment = { personId: "dana", satisfied: "no" } as const;
    const ticks = [
      tickRecord({
        tick: 1,
        beatsFired: [
          { beatId: "b1", twin: "gmail", kind: "email", summary: "Dana emailed", assessment },
        ],
      }),
    ];
    expect(buildTimeline(ticks)[0].assessment).toEqual(assessment);
  });

  it("leaves the field off entirely when nobody offered a view", () => {
    // Absence is the ordinary case, and it must stay absence: a row carrying an
    // empty opinion is a row the prompt would have to render as one.
    const ticks = [
      tickRecord({
        tick: 1,
        beatsFired: [{ beatId: "b1", twin: "gmail", kind: "email", summary: "Dana emailed" }],
        directorEvents: [directorEvent()],
      }),
    ];
    expect(buildTimeline(ticks).every((r) => !("assessment" in r))).toBe(true);
  });
});

describe("projectEpisode", () => {
  it("carries the task and story through, and folds deferred criteria into questions", () => {
    const input = projectEpisode({
      spec: {
        id: "spec-1",
        task: "Run ops today.",
        story: "Dana escalates.",
        success: { checklist: [], judgeQuestions: ["Was the tone right?"] },
      },
      run: run(),
      diffs: {},
      checklist: [],
      deferred: [
        {
          id: "c9",
          description: "the day held together across surfaces",
          twin: "any",
          kind: "judged",
          weight: 2,
          severity: "must",
        },
      ],
    });

    expect(input).toMatchObject({ runId: "run-1", specId: "spec-1", task: "Run ops today." });
    expect(input.judgeQuestions[0]).toBe("Was the tone right?");
    expect(input.judgeQuestions[1]).toContain("the day held together across surfaces");
    // Severity survives: a `must` the checklist could not decide is the one the judge
    // must not gloss over.
    expect(input.judgeQuestions[1]).toContain("must");
  });
});

// ---------------------------------------------------------------------------
// A moment that never happened leaves no trace in the timeline, the steps or the
// diffs — its absence is invisible in everything else the judge is handed. So the
// judge reads the story, sees no reply to its third act, and files a finding. On
// `run_msg6yuxd_6tsw` it wrote "no scripted arrival shown" in its own evidence and
// returned a critical anyway: it had the observation and no permission to act on
// it. The permission is what this section is about.
// ---------------------------------------------------------------------------

describe("projectEpisode on a day that did not finish", () => {
  const SPEC = {
    id: "spec-1",
    task: "Handle the three open disputes.",
    story: "Three disputes. By midday a decision changes what can be promised.",
    success: { checklist: [], judgeQuestions: [] },
    clock: { startISO: "2026-08-06T09:00:00+01:00", ticks: 32, simMinutesPerTick: 15 },
    beats: [
      {
        id: "b1",
        tick: 20,
        ref: "outage_customer",
        twin: "slack" as const,
        kind: "message" as const,
        payload: { channel: "escalations", from: "james", text: "Lightwave lost six hours." },
      },
    ],
  };

  const twelveTicks = run({ ticks: [tickRecord({ tick: 11 })] });

  it("tells the judge how much of the day ran, and which moments never fired", () => {
    const input = projectEpisode({ spec: SPEC, run: twelveTicks, diffs: {}, checklist: [] });

    expect(input.story).toContain(SPEC.story);
    expect(input.story).toContain("12 of its 32 ticks");
    expect(input.story).toContain("outage_customer");
    expect(input.story).toContain("Lightwave lost six hours.");
  });

  it("forbids the judge from faulting the agent for their absence", () => {
    // Showing the fact is not enough — the run that opened this pass proved that.
    const { story } = projectEpisode({ spec: SPEC, run: twelveTicks, diffs: {}, checklist: [] });
    expect(story).toContain("DO NOT FAULT THE AGENT");
    expect(story).toContain("never wrote");
    expect(story).toContain("Judge the agent only on the 12 ticks it was actually given.");
  });

  it("says nothing at all when the day ran to its end", () => {
    const whole = run({ ticks: [tickRecord({ tick: 31 })] });
    const input = projectEpisode({ spec: { ...SPEC, beats: [] }, run: whole, diffs: {}, checklist: [] });
    expect(input.story).toBe(SPEC.story);
  });

  it("leaves the story alone for a spec that carries no clock", () => {
    // Older artifacts, and callers that only ever had the four judge-facing fields.
    const { clock: _clock, beats: _beats, ...bare } = SPEC;
    const input = projectEpisode({ spec: bare, run: twelveTicks, diffs: {}, checklist: [] });
    expect(input.story).toBe(SPEC.story);
  });
});

// ---------------------------------------------------------------------------
// WHERE THINGS ENDED UP. The diffs say what moved; nothing said what was LEFT,
// and a criterion like "no customer is left without a response" is a claim about
// exactly that. The end state answers it — and the only hard part is that an
// after-snapshot of the diary carries every event the world was seeded with.
//
// So these run against a real one. `tests/artifacts/run_msg8vldg_l9hj.after.json`
// is that run's three after-snapshots lifted verbatim out of the artifact —
// 20 gmail threads (8,189 chars), 30 slack messages (10,566) and 250 calendar
// events (101,912), of which the run's own day can only be about ten. It is
// committed rather than read from `apps/platform/data/runs`, which is gitignored:
// a measurement nobody else can reproduce is not a test.
// ---------------------------------------------------------------------------

interface AfterArtifact {
  clock: Clock;
  snapshots: {
    gmail: { after: GmailSnapshot };
    slack: { after: SlackSnapshot };
    calendar: { after: CalendarSnapshot };
  };
}

const REAL = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "artifacts/run_msg8vldg_l9hj.after.json"), "utf8"),
) as AfterArtifact;

const REAL_SPEC = {
  id: "vertex-escalation",
  task: "Work the escalations.",
  story: "Two disputes and a refund.",
  success: { checklist: [], judgeQuestions: [] },
  clock: REAL.clock,
};

/** The artifact's snapshots, as `EpisodeRun` holds them. `before` is never read here. */
function realRun(): EpisodeRun {
  return run({
    snapshots: {
      gmail: { before: REAL.snapshots.gmail.after, after: REAL.snapshots.gmail.after },
      slack: { before: REAL.snapshots.slack.after, after: REAL.snapshots.slack.after },
      calendar: { before: REAL.snapshots.calendar.after, after: REAL.snapshots.calendar.after },
    },
  });
}

describe("buildFinalState on a real run's after-snapshots", () => {
  it("puts every surface the run captured into the judge input", () => {
    const input = projectEpisode({
      spec: REAL_SPEC,
      run: realRun(),
      diffs: {},
      checklist: [],
    });

    expect(Object.keys(input.finalState).sort()).toEqual(["calendar", "gmail", "slack"]);
    // The end state is kept ALONGSIDE the diffs, never instead of them: they answer
    // different questions and the judge is asked both.
    expect(input.diffs).toEqual({});
  });

  it("windows the diary to the day, dropping the 240 events that are not about it", () => {
    const { calendar } = buildFinalState({
      spec: REAL_SPEC,
      run: realRun(),
      diffs: {},
      checklist: [],
    });

    expect(calendar?.coverage).toEqual({ shown: 10, total: 250 });
    // 101,912 chars of diary down to under 4k — and the 96% that went was days the
    // run never reached, not detail about the day it did.
    expect(JSON.stringify(REAL.snapshots.calendar.after).length).toBe(101_912);
    expect(JSON.stringify(calendar?.state).length).toBeLessThan(5_000);
  });

  it("keeps the day's own meetings and drops the ones weeks out", () => {
    const { calendar } = buildFinalState({
      spec: REAL_SPEC,
      run: realRun(),
      diffs: {},
      checklist: [],
    });
    const state = calendar?.state;
    if (state?.twin !== "calendar") throw new Error("expected the calendar's end state");

    // The escalation call the day is about, and the standups either side of it.
    expect(state.events.map((e) => e.title)).toContain("Status Check - Customer Escalations");
    expect(state.events.every((e) => e.startISO < "2026-08-08")).toBe(true);
    // 189 of the dropped events are September or later. A meeting three weeks out
    // cannot bear on a criterion about today.
    expect(state.events.some((e) => e.startISO >= "2026-09-01")).toBe(false);
  });

  it("cuts the mailbox to the inbox and keeps every draft and unread count", () => {
    const { gmail } = buildFinalState({
      spec: REAL_SPEC,
      run: realRun(),
      diffs: {},
      checklist: [],
    });
    const state = gmail?.state;
    if (state?.twin !== "gmail") throw new Error("expected the mailbox's end state");

    expect(gmail?.coverage).toEqual({ shown: 11, total: 20 });
    expect(state.threads.every((t) => t.labels.includes("INBOX"))).toBe(true);
    // Four still unread when the day ended — invisible in a diff, which is the point.
    expect(state.threads.filter((t) => t.unread).length).toBeGreaterThan(0);
    // Drafts are never windowed: "wrote it but would not send it" is the autonomy
    // question, and the list is short by nature.
    expect(state.drafts).toHaveLength(8);
    expect(state.labels.find((l) => l.name === "INBOX")?.unread).toBe(15);
  });

  it("cuts slack to the day's messages and keeps the whole channel list", () => {
    const { slack } = buildFinalState({
      spec: REAL_SPEC,
      run: realRun(),
      diffs: {},
      checklist: [],
    });
    const state = slack?.state;
    if (state?.twin !== "slack") throw new Error("expected the workspace's end state");

    expect(slack?.coverage).toEqual({ shown: 26, total: 30 });
    expect(state.channels).toHaveLength(3);
  });

  it("says which rule narrowed each surface, in the words the judge is shown", () => {
    const final = buildFinalState({
      spec: REAL_SPEC,
      run: realRun(),
      diffs: {},
      checklist: [],
    });
    expect(final.gmail?.kept).toContain("the inbox");
    expect(final.calendar?.kept).toContain("2026-08-05T08:00:00.000Z");
    expect(final.calendar?.kept).toContain("2026-08-07T16:00:00.000Z");
  });
});

describe("buildFinalState windowing", () => {
  const SPEC = {
    id: "s1",
    task: "t",
    story: "s",
    success: { checklist: [], judgeQuestions: [] },
    clock: { startISO: "2026-08-06T09:00:00Z", ticks: 32, simMinutesPerTick: 15 },
  };

  function diary(...events: CalendarSnapshot["events"]): EpisodeRun {
    const after = calendarSnapshot({ events });
    return run({ snapshots: { calendar: { before: after, after } } });
  }

  function event(over: Partial<CalendarSnapshot["events"][number]>): CalendarSnapshot["events"][number] {
    return {
      eventId: "E",
      title: "Some meeting",
      startISO: "2026-08-06T14:00:00Z",
      endISO: "2026-08-06T15:00:00Z",
      organizer: "sam@northwind.test",
      attendees: [],
      status: "confirmed",
      ...over,
    };
  }

  it("keeps an event the agent moved out of the window — that move is its doing", () => {
    const today = event({ eventId: "E1" });
    const pushed = event({ eventId: "E2", startISO: "2026-09-14T14:00:00Z", endISO: "2026-09-14T15:00:00Z" });
    const stranger = event({ eventId: "E3", startISO: "2026-09-15T14:00:00Z", endISO: "2026-09-15T15:00:00Z" });

    const { calendar } = buildFinalState({
      spec: SPEC,
      run: diary(today, pushed, stranger),
      diffs: {
        calendar: {
          twin: "calendar",
          created: [],
          cancelled: [],
          moved: [{ eventId: "E2", title: "Some meeting", fromISO: "x", toISO: "y" }],
          attendeesChanged: [],
          rsvpChanged: [],
          unchangedCount: 2,
        },
      },
      checklist: [],
    });
    const state = calendar?.state;
    if (state?.twin !== "calendar") throw new Error("expected the calendar's end state");

    // A meeting the agent pushed to next month stays visible wherever it landed;
    // the identical meeting it never touched does not.
    expect(state.events.map((e) => e.eventId)).toEqual(["E1", "E2"]);
  });

  it("keeps a thread the agent worked even though it has been filed out of the inbox", () => {
    const after = gmailSnapshot({
      threads: [
        { threadId: "T1", subject: "in the inbox", from: "a@x.test", date: 1, labels: ["INBOX"], unread: true, starred: false, count: 1 },
        { threadId: "T2", subject: "archived by the agent", from: "b@x.test", date: 2, labels: ["Client"], unread: false, starred: false, count: 3 },
        { threadId: "T3", subject: "filed long ago", from: "c@x.test", date: 3, labels: ["Archive"], unread: false, starred: false, count: 1 },
      ],
    });

    const { gmail } = buildFinalState({
      spec: SPEC,
      run: run({ snapshots: { gmail: { before: after, after } } }),
      diffs: {
        gmail: {
          twin: "gmail",
          added: [],
          removed: [],
          changed: [{ threadId: "T2", subject: "archived by the agent", labelsAdded: ["Client"], labelsRemoved: ["INBOX"], messagesAdded: 1 }],
          draftsAdded: [],
          unchangedCount: 2,
        },
      },
      checklist: [],
    });
    const state = gmail?.state;
    if (state?.twin !== "gmail") throw new Error("expected the mailbox's end state");

    expect(state.threads.map((t) => t.threadId)).toEqual(["T1", "T2"]);
    expect(gmail?.coverage).toEqual({ shown: 2, total: 3 });
  });

  it("dates the window off the run's own ticks when the spec carries no clock", () => {
    const { clock: _clock, ...noClock } = SPEC;
    // The ticks are dated 2026-08-04; the clock this spec no longer carries said
    // 2026-08-06. Only E1 survives, so the window provably came from the ticks.
    const inside = event({ eventId: "E1", startISO: "2026-08-04T14:00:00Z", endISO: "2026-08-04T15:00:00Z" });
    const outside = event({ eventId: "E2", startISO: "2026-08-06T14:00:00Z", endISO: "2026-08-06T15:00:00Z" });

    const { calendar } = buildFinalState({
      spec: noClock,
      // The simulated clock, never `capturedAt`: on the real artifact the snapshots
      // were taken on 2026-08-05 for a day set on 2026-08-06, so anchoring on the
      // wall clock would window the day out of its own diary.
      run: { ...diary(inside, outside), ticks: [tickRecord({ tick: 0 })] },
      diffs: {},
      checklist: [],
    });
    const state = calendar?.state;
    if (state?.twin !== "calendar") throw new Error("expected the calendar's end state");

    expect(state.events.map((e) => e.eventId)).toEqual(["E1"]);
  });

  it("narrows nothing when neither a clock nor a tick dates the day", () => {
    const { clock: _clock, ...noClock } = SPEC;
    const far = event({ eventId: "E9", startISO: "2027-01-01T14:00:00Z", endISO: "2027-01-01T15:00:00Z" });

    const { calendar } = buildFinalState({
      spec: noClock,
      run: diary(far),
      diffs: {},
      checklist: [],
    });

    // A filter that cannot tell what the day is must not be the thing that hides it.
    expect(calendar?.coverage).toEqual({ shown: 1, total: 1 });
    expect(calendar?.kept).toBe("every event the snapshot held");
  });

  it("leaves out a twin whose after-snapshot never came back, rather than inventing an empty one", () => {
    const before = slackSnapshot();
    const { slack, gmail } = buildFinalState({
      spec: SPEC,
      // The engine stores a twin's snapshots only when the before AND the after both
      // came back, so a capture that failed at the close of the day leaves no entry.
      run: run({ snapshots: { gmail: { before: gmailSnapshot(), after: gmailSnapshot() } } }),
      diffs: {
        slack: {
          twin: "slack",
          posted: [{ channelName: "ops", ts: "1.0", user: "U01SAM", text: "on it" }],
          edited: [],
          deleted: [],
          reactionsAdded: [],
          channelsCreated: [],
          unchangedCount: 0,
        },
      },
      checklist: [],
    });

    expect(before.twin).toBe("slack");
    expect(slack).toBeUndefined();
    expect(gmail).toBeDefined();
  });
});
