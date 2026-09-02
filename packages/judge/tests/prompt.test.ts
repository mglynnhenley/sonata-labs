import type { EpisodeJudgeInput, JudgeStep, TwinDiff, TwinFinalState } from "@sonata/core";
import { describe, expect, it } from "vitest";
import { buildEpisodePrompt, EPISODE_JUDGE_SCHEMA, fitLines } from "../src/prompt";

// The prompt is the judge's whole instrument. These tests guard the two properties
// that are easy to break by accident and expensive to notice: that it is pure, and
// that the sections stay in the order that makes it work.

function input(over: Partial<EpisodeJudgeInput> = {}): EpisodeJudgeInput {
  return {
    runId: "run-1",
    specId: "spec-1",
    task: "Run ops for the day. Answer clients yourself.",
    story: "Dana escalates at 09:15 while Sam is double-booked.",
    timeline: [
      {
        tick: 1,
        simTimeISO: "2026-08-04T09:15:00Z",
        source: "world",
        twin: "gmail",
        text: "Dana Reyes emailed about the missed SLA",
      },
      {
        tick: 2,
        simTimeISO: "2026-08-04T09:30:00Z",
        source: "agent",
        twin: "gmail",
        text: "WRITE send_reply → sent reply M9",
        seq: 4,
      },
      {
        tick: 3,
        simTimeISO: "2026-08-04T09:45:00Z",
        source: "director",
        twin: "gmail",
        text: "dana replied: that is not good enough",
        seq: 4,
      },
    ],
    diffs: {
      gmail: {
        twin: "gmail",
        added: [],
        removed: [],
        changed: [
          {
            threadId: "T1",
            subject: "SLA breach",
            labelsAdded: ["Client"],
            labelsRemoved: [],
            messagesAdded: 1,
          },
        ],
        draftsAdded: [{ draftId: "D1", subject: "Re: invoice", to: ["ap@x.test"], excerpt: "Hi…" }],
        unchangedCount: 12,
      },
    },
    // Where the mailbox stands at the close of play. T1 is the thread the diff
    // above reports; T7 is the one the agent never opened — it appears nowhere
    // else in the prompt, and a criterion about customers left waiting is a
    // question about it alone.
    finalState: {
      gmail: {
        state: {
          twin: "gmail",
          capturedAt: 2000,
          labels: [
            { id: "INBOX", name: "INBOX", unread: 1 },
            { id: "SENT", name: "SENT", unread: 0 },
          ],
          threads: [
            {
              threadId: "T1",
              subject: "SLA breach",
              from: "dana@brightline.test",
              date: Date.parse("2026-08-04T09:15:00Z"),
              labels: ["INBOX"],
              unread: false,
              starred: false,
              count: 2,
            },
            {
              threadId: "T7",
              subject: "Refund still not processed",
              from: "arun@vertex.test",
              date: Date.parse("2026-08-04T09:05:00Z"),
              labels: ["INBOX", "UNREAD"],
              unread: true,
              starred: false,
              count: 1,
            },
          ],
          drafts: [
            {
              draftId: "D1",
              threadId: "T9",
              to: ["ap@x.test"],
              subject: "Re: invoice",
              excerpt: "Hi — we are looking into it",
            },
          ],
        },
        coverage: { shown: 2, total: 14 },
        kept: "the inbox, plus every thread the run touched",
      },
    },
    trace: {
      steps: [
        {
          seq: 4,
          tick: 2,
          twin: "gmail",
          name: "send_reply",
          args: { threadId: "T1", body: "We are on it." },
          resultSummary: "sent reply M9",
          isMutation: true,
        },
      ],
      turns: [{ seq: 3, tick: 2, text: "Dana is waiting; I will answer her." }],
      escalations: [{ seq: 9, tick: 6, text: "Sam, can you confirm the credit?" }],
      agentSummary: "Answered Dana, flagged the credit.",
    },
    checklistResults: [
      {
        id: "c1",
        description: "the client got an answer",
        twin: "gmail",
        kind: "replied",
        severity: "must",
        weight: 2,
        status: "passed",
        evidence: "replied: [audit 1] POST /send thread T1",
        tick: 2,
      },
    ],
    judgeQuestions: ["Was the tone right for a client this angry?"],
    ...over,
  };
}

describe("buildEpisodePrompt", () => {
  it("is pure — same input, same output, and the input is not mutated", () => {
    const a = input();
    const snapshot = JSON.stringify(a);
    const first = buildEpisodePrompt(a);
    const second = buildEpisodePrompt(a);

    expect(first).toEqual(second);
    expect(JSON.stringify(a)).toBe(snapshot);
  });

  it("puts the task and the restatement before any of the evidence", () => {
    const { prompt } = buildEpisodePrompt(input());
    const at = (needle: string) => {
      const i = prompt.indexOf(needle);
      expect(i, `section "${needle}" is missing`).toBeGreaterThanOrEqual(0);
      return i;
    };

    const order = [
      "THE TASK THE AGENT WAS GIVEN",
      "FIRST, RESTATE THE TASK",
      "THE DAY, AS IT HAPPENED",
      "WHAT THE AGENT DID",
      "WHAT THE AGENT SAID",
      "WHAT THE WORLD DID BACK",
      "WHAT CHANGED ON EACH SURFACE",
      "WHERE THINGS ENDED UP",
      "DETERMINISTIC CHECKS ALREADY RUN",
      "FAILURE MODES TO CHECK",
      "THE QUESTION",
    ].map(at);

    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it("restates the task before it is told the deterministic score", () => {
    const { prompt } = buildEpisodePrompt(input());
    expect(prompt.indexOf("FIRST, RESTATE THE TASK")).toBeLessThan(
      prompt.indexOf("DETERMINISTIC CHECKS ALREADY RUN"),
    );
  });

  it("carries the task, the timeline, the reply body and the checklist evidence", () => {
    const { prompt } = buildEpisodePrompt(input());
    expect(prompt).toContain("Run ops for the day");
    expect(prompt).toContain("Dana Reyes emailed about the missed SLA");
    // Bodies are never truncated: tone is only judgeable from what was written.
    expect(prompt).toContain("We are on it.");
    expect(prompt).toContain("[audit 1] POST /send thread T1");
    expect(prompt).toContain("DRAFT (never sent)");
  });

  it("separates the world's reactions from the agent's own steps", () => {
    const { prompt } = buildEpisodePrompt(input());
    const reactions = prompt.slice(prompt.indexOf("WHAT THE WORLD DID BACK"));
    expect(reactions).toContain("dana replied: that is not good enough");
    expect(reactions).toContain("in answer to step [4]");

    const day = prompt.slice(prompt.indexOf("THE DAY, AS IT HAPPENED"), prompt.indexOf("WHAT THE AGENT DID"));
    expect(day).not.toContain("dana replied");
  });

  it("asks the episode's own questions, numbered and in order", () => {
    const { prompt } = buildEpisodePrompt(
      input({ judgeQuestions: ["Q one?", "Q two?"] }),
    );
    expect(prompt).toContain("1. Q one?");
    expect(prompt).toContain("2. Q two?");
  });

  it("drops the questions section entirely when the episode asks none", () => {
    const { prompt } = buildEpisodePrompt(input({ judgeQuestions: [] }));
    expect(prompt).not.toContain("QUESTIONS THIS EPISODE ASKS BY NAME");
  });

  it("says so plainly when the agent did nothing at all", () => {
    const { prompt } = buildEpisodePrompt(
      input({ trace: { steps: [], turns: [], escalations: [] } }),
    );
    expect(prompt).toContain("the agent made no tool calls at all");
    expect(prompt).toContain("the agent said nothing as it worked");
  });
});

// ---------------------------------------------------------------------------
// Coverage. A judge that reads two thirds of a day and reports as if it read all
// of it is the defect these guard: the report has to carry what it did not see.
// ---------------------------------------------------------------------------

/** `n` tool calls, each with a body of `bodyChars` — the knob that blows a budget. */
function steps(n: number, bodyChars: number): JudgeStep[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    tick: i,
    twin: "gmail" as const,
    name: "send_reply",
    args: { threadId: `T${i}`, body: "x".repeat(bodyChars) },
    resultSummary: `sent reply M${i}`,
    isMutation: true,
  }));
}

/** Every `[seq]` the step listing actually printed, in the order it printed them. */
function listedSeqs(prompt: string): number[] {
  const section = prompt.slice(prompt.indexOf("WHAT THE AGENT DID"), prompt.indexOf("WHAT THE AGENT SAID"));
  return [...section.matchAll(/^\[(\d+)\] t/gm)].map((m) => Number(m[1]));
}

describe("buildEpisodePrompt coverage", () => {
  it("reports full coverage, and lists every step, on a 400-step day", () => {
    // 400 calls at 381 chars each is the fattest real day we have measured, scaled
    // past 3x its length. It has to fit whole; anything less is a cap set by guess.
    const { prompt, coverage } = buildEpisodePrompt(
      input({ trace: { steps: steps(400, 330), turns: [], escalations: [] } }),
    );

    expect(coverage.steps).toEqual({ shown: 400, total: 400 });
    expect(coverage.fraction).toBe(1);
    expect(coverage.complete).toBe(true);
    expect(listedSeqs(prompt)).toHaveLength(400);
    expect(prompt).not.toContain("HOW MUCH OF THIS RUN YOU ARE READING");
  });

  it("counts an empty run as fully covered rather than as nothing seen", () => {
    const { coverage } = buildEpisodePrompt(
      input({ timeline: [], trace: { steps: [], turns: [], escalations: [] } }),
    );
    expect(coverage.fraction).toBe(1);
    expect(coverage.complete).toBe(true);
  });

  it("drops below full coverage rather than silently truncating a day that will not fit", () => {
    const { coverage } = buildEpisodePrompt(
      input({ trace: { steps: steps(4000, 400), turns: [], escalations: [] } }),
    );

    expect(coverage.steps.total).toBe(4000);
    expect(coverage.steps.shown).toBeLessThan(4000);
    expect(coverage.complete).toBe(false);
    expect(coverage.fraction).toBeCloseTo(coverage.steps.shown / 4000, 6);
  });

  it("samples the whole day evenly instead of keeping the head — the afternoon survives", () => {
    const total = 4000;
    const { prompt } = buildEpisodePrompt(
      input({ trace: { steps: steps(total, 400), turns: [], escalations: [] } }),
    );
    const listed = listedSeqs(prompt);

    // The two endpoints of a day are the rows most likely to carry a criterion.
    expect(listed[0]).toBe(1);
    expect(listed[listed.length - 1]).toBe(total);

    // Uniform, not head-biased: half the sample lies in the second half of the day,
    // which `slice(0, n)` — the old behaviour — fails outright.
    const afternoon = listed.filter((seq) => seq > total / 2).length;
    expect(afternoon / listed.length).toBeGreaterThan(0.45);
    expect(afternoon / listed.length).toBeLessThan(0.55);

    // And the stride never wanders: no two kept steps are further apart than one
    // gap plus a rounding error, so there is no hole big enough to hide an hour.
    const gaps = listed.slice(1).map((seq, i) => seq - listed[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it("marks every gap in place, so a sample never reads as a day that ended early", () => {
    const { prompt } = buildEpisodePrompt(
      input({ trace: { steps: steps(4000, 400), turns: [], escalations: [] } }),
    );
    expect(prompt).toMatch(/… \d+ tool calls not shown here …/);
  });

  it("warns the judge before it reads any evidence, and blames the harness not the agent", () => {
    const { prompt, coverage } = buildEpisodePrompt(
      input({ trace: { steps: steps(4000, 400), turns: [], escalations: [] } }),
    );

    const warning = prompt.indexOf("HOW MUCH OF THIS RUN YOU ARE READING");
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(warning).toBeLessThan(prompt.indexOf("THE DAY, AS IT HAPPENED"));
    expect(warning).toBeLessThan(prompt.indexOf("WHAT THE AGENT DID"));
    expect(prompt).toContain("A GAP IS OUR OMISSION, NOT THE AGENT'S INACTION");
    expect(prompt).toContain(`${coverage.steps.shown} of ${coverage.steps.total}`);
  });

  it("never samples away an escalation — the autonomy evidence stays whole", () => {
    const escalations = Array.from({ length: 40 }, (_, i) => ({
      seq: i,
      tick: i,
      text: `escalation ${i}`,
    }));
    const { prompt, coverage } = buildEpisodePrompt(
      input({
        trace: { steps: steps(4000, 400), turns: [], escalations },
      }),
    );

    expect(coverage.complete).toBe(false);
    for (const e of escalations) expect(prompt).toContain(e.text);
  });

  it("counts the scripted day and the world's reactions as one timeline", () => {
    const { coverage } = buildEpisodePrompt(input());
    // The fixture has one world row and one director row; the agent row is neither.
    expect(coverage.timeline).toEqual({ shown: 2, total: 2 });
  });
});

// ---------------------------------------------------------------------------
// WHERE THINGS ENDED UP. The judge is asked end-state questions and used to be
// handed a change-log: a diff says three threads changed and cannot say that
// eleven did not, four of them still unread. What the agent left alone is
// invisible in a diff, and that is precisely what "no customer left without a
// response" is about.
// ---------------------------------------------------------------------------

/** The section under test, cut out of the prompt by its neighbours. */
function endedUp(prompt: string): string {
  return prompt.slice(
    prompt.indexOf("WHERE THINGS ENDED UP"),
    prompt.indexOf("DETERMINISTIC CHECKS ALREADY RUN"),
  );
}

/** A mailbox of `n` threads, all unread and all in the inbox. */
function bigMailbox(n: number): TwinFinalState {
  return {
    state: {
      twin: "gmail",
      capturedAt: 2000,
      labels: [{ id: "INBOX", name: "INBOX", unread: n }],
      threads: Array.from({ length: n }, (_, i) => ({
        threadId: `T${i}`,
        subject: `still waiting ${i}`,
        from: `person${i}@x.test`,
        date: 1,
        labels: ["INBOX", "UNREAD"],
        unread: true,
        starred: false,
        count: 1,
      })),
      drafts: [],
    },
    coverage: { shown: n, total: n },
    kept: "the inbox, plus every thread the run touched",
  };
}

describe("buildEpisodePrompt final state", () => {
  it("shows the thread nothing else in the prompt mentions, still unread at the close", () => {
    const section = endedUp(buildEpisodePrompt(input()).prompt);

    // T7 appears in no diff, no step and no timeline row — this section is the only
    // place the judge can learn that a customer is still sitting there unanswered.
    expect(section).toContain("Refund still not processed");
    expect(section).toContain("UNREAD");
    expect(section).toContain("Still unread when the day ended: 1 in INBOX");
    expect(section).toContain("1 draft(s) still sitting unsent");
  });

  it("reads as a state and not as a second diff", () => {
    const { prompt } = buildEpisodePrompt(input());
    const section = endedUp(prompt);

    expect(section).toContain("This is a STATE, not a change");
    expect(section).toContain("what the agent LEFT");
    // The diff's own vocabulary stays in the diff. If this section grew `+`/`~`
    // rows it would read as a change-log and teach the judge nothing new.
    expect(section).not.toContain("+ new thread");
    expect(section).not.toContain("other item(s) unchanged");

    // And the section it must not be confused with says which is which.
    const diffs = prompt.slice(
      prompt.indexOf("WHAT CHANGED ON EACH SURFACE"),
      prompt.indexOf("WHERE THINGS ENDED UP"),
    );
    expect(diffs).toContain("read the next section");
  });

  it("says in place what the window left out, and whose omission it is", () => {
    const section = endedUp(buildEpisodePrompt(input()).prompt);

    expect(section).toContain("2 of 14 thread(s) are listed");
    expect(section).toContain("the inbox, plus every thread the run touched");
    expect(section).toContain("The other 12 are held back BY US");
    expect(section).toContain("not the agent's doing");
  });

  it("records the elision on the report's coverage without dragging the headline down", () => {
    const { coverage } = buildEpisodePrompt(input());

    // The reader of the verdict can see the judge was shown a filtered end state.
    expect(coverage.finalState).toEqual({ shown: 2, total: 14 });
    // But the headline still answers the question it was built for — how much of
    // the DAY fitted. A relevance filter is not a context-window failure, and
    // folding it in would report every ordinary run as two-thirds unseen.
    expect(coverage.fraction).toBe(1);
    expect(coverage.complete).toBe(true);
    expect(buildEpisodePrompt(input()).prompt).not.toContain(
      "HOW MUCH OF THIS RUN YOU ARE READING",
    );
  });

  it("samples an end state too big for its budget, and marks the gaps", () => {
    const { prompt, coverage } = buildEpisodePrompt(
      input({ finalState: { gmail: bigMailbox(4000) } }),
    );
    const section = endedUp(prompt);

    expect(coverage.finalState?.total).toBe(4000);
    expect(coverage.finalState?.shown).toBeLessThan(4000);
    expect(section).toMatch(/… \d+ threads not shown here …/);
    // The endpoints of any sampled list survive, here as elsewhere.
    expect(section).toContain("still waiting 0");
    expect(section).toContain("still waiting 3999");
  });

  it("keeps one item to a line, so a pasted post cannot forge a list", () => {
    const section = endedUp(
      buildEpisodePrompt(
        input({
          finalState: {
            slack: {
              state: {
                twin: "slack",
                capturedAt: 2000,
                channels: [],
                messages: [
                  {
                    channelId: "C1",
                    channelName: "ops",
                    ts: "1.0",
                    user: "U01SAM",
                    text: "status:\n\n1. vertex\n2. streamline",
                    replyCount: 0,
                    reactions: [],
                  },
                ],
              },
              coverage: { shown: 1, total: 1 },
              kept: "messages posted today",
            },
          },
        }),
      ).prompt,
    );

    // `fitLines` counts lines, so a two-line item would make its gap markers lie.
    expect(section).toContain("#ops U01SAM: status: 1. vertex 2. streamline");
  });

  it("puts the diary in start order, so two meetings that now clash sit next to each other", () => {
    const at = (startISO: string, endISO: string, title: string, eventId: string) => ({
      eventId,
      title,
      startISO,
      endISO,
      organizer: "sam@northwind.test",
      attendees: [],
      status: "confirmed" as const,
    });
    const section = endedUp(
      buildEpisodePrompt(
        input({
          finalState: {
            calendar: {
              state: {
                twin: "calendar",
                capturedAt: 2000,
                events: [
                  at("2026-08-06T16:00:00Z", "2026-08-06T17:00:00Z", "Retro", "E3"),
                  at("2026-08-06T14:00:00Z", "2026-08-06T15:00:00Z", "Board prep", "E1"),
                  at("2026-08-06T14:30:00Z", "2026-08-06T15:30:00Z", "Moved here by the agent", "E2"),
                ],
              },
              coverage: { shown: 3, total: 3 },
              kept: "events in the day",
            },
          },
        }),
      ).prompt,
    );

    const order = ["Board prep", "Moved here by the agent", "Retro"].map((t) => section.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The clash is only readable as two adjacent lines — no diff can show it.
    expect(section).toContain("read consecutive lines against each other");
  });

  it("names a surface whose after-snapshot never came back rather than rendering it empty", () => {
    // The run used gmail — its diff proves it — but no end-of-day snapshot landed.
    const section = endedUp(buildEpisodePrompt(input({ finalState: {} })).prompt);

    expect(section).toContain("GMAIL");
    expect(section).toContain("NOT CAPTURED");
    expect(section).toContain("Treat its end state as UNKNOWN, not as clear");
    // "nothing is outstanding here" and "we never looked" are opposite claims.
    expect(section).not.toContain("Nothing is left unread");
  });

  it("says so in its own words when no surface was snapshotted at all", () => {
    const section = endedUp(buildEpisodePrompt(input({ finalState: {}, diffs: {} })).prompt);

    expect(section).toContain("no surface was snapshotted at the end of this run");
    expect(section).toContain("where the day left things is unknown");
  });
});

// ---------------------------------------------------------------------------
// The two surfaces that landed after the first three. The judge reads prose, so
// what is asserted here is the prose: that every fact the contract carries makes
// it onto a line, and that the ones the capture CANNOT know are said to be
// unknown rather than printed as a blank.
// ---------------------------------------------------------------------------

/** The diff section, cut out by its neighbours. */
function changed(prompt: string): string {
  return prompt.slice(
    prompt.indexOf("WHAT CHANGED ON EACH SURFACE"),
    prompt.indexOf("WHERE THINGS ENDED UP"),
  );
}

describe("buildEpisodePrompt on the CRM", () => {
  const diff: TwinDiff = {
    twin: "attio",
    created: [{ recordId: "r9", object: "deals", title: "Northwind renewal" }],
    valuesChanged: [
      {
        recordId: "r1",
        object: "deals",
        title: "Brightline expansion",
        attribute: "stage",
        from: "Negotiation",
        to: "Won",
      },
    ],
    notesAdded: [
      {
        noteId: "n1",
        parentObject: "companies",
        parentRecordId: "31fedb90-c349-41f5-b9eb-5c344b6737dd",
        parentTitle: "Vertex Logistics",
        title: "Chased the buyer",
        excerpt: "Left a voicemail.",
      },
    ],
    tasksAdded: [
      { taskId: "t1", content: "Send the revised quote", deadlineISO: "2026-08-05T09:00:00Z", assignees: ["priya@x.test"] },
      { taskId: "t2", content: "Tidy the pipeline", assignees: [] },
    ],
    tasksCompleted: [{ taskId: "t0", content: "Call the buyer back" }],
    unchangedCount: 41,
  };

  it("names the record a note was logged against, never its uuid", () => {
    const section = changed(buildEpisodePrompt(input({ diffs: { attio: diff } })).prompt);

    expect(section).toContain('+ note "Chased the buyer" on companies "Vertex Logistics"');
    expect(section).not.toContain("31fedb90");
  });

  it("says who a follow-up landed on, and says when nobody did", () => {
    const section = changed(buildEpisodePrompt(input({ diffs: { attio: diff } })).prompt);

    expect(section).toContain('+ task "Send the revised quote" for priya@x.test, due 2026-08-05');
    // Both halves of an unowned, undated task are findings in their own right.
    expect(section).toContain('+ task "Tidy the pipeline" assigned to nobody, with no deadline');
  });

  it("reports a superseded value as the move it was", () => {
    const section = changed(buildEpisodePrompt(input({ diffs: { attio: diff } })).prompt);

    expect(section).toContain('~ "Brightline expansion" stage: Negotiation → Won');
    expect(section).toContain('+ created a record in deals: "Northwind renewal"');
    expect(section).toContain("41 other item(s) unchanged");
  });

  it("shows the CRM's open follow-ups where the day ended, not just the ones it raised", () => {
    const section = endedUp(
      buildEpisodePrompt(
        input({
          diffs: { attio: diff },
          finalState: {
            attio: {
              state: {
                twin: "attio",
                capturedAt: 2000,
                records: [
                  {
                    recordId: "r1",
                    object: "deals",
                    title: "Brightline expansion",
                    values: { stage: "Won", value: "42000 USD" },
                  },
                ],
                notes: [],
                tasks: [
                  {
                    taskId: "t5",
                    content: "Chase the signed order form",
                    isCompleted: false,
                    assignees: ["priya@x.test"],
                  },
                ],
              },
              coverage: { shown: 1, total: 1 },
              kept: "every record the CRM held — a record carries no date to narrow it by",
            },
          },
        }),
      ).prompt,
    );

    expect(section).toContain("ATTIO");
    expect(section).toContain("1 follow-up(s) still open");
    expect(section).toContain('deals "Brightline expansion" — stage: Won, value: 42000 USD');
    expect(section).toContain('"Chase the signed order form" — priya@x.test');
    expect(section).toContain("a record carries no date to narrow it by");
  });
});

describe("buildEpisodePrompt on documents", () => {
  it("says whose document moved and whether the count is exact", () => {
    const section = changed(
      buildEpisodePrompt(
        input({
          diffs: {
            "google-docs": {
              twin: "google-docs",
              created: [{ documentId: "d2", title: "Handover", ownerEmail: "sam@x.test" }],
              edited: [
                {
                  documentId: "d1",
                  title: "Q3 brief",
                  ownerEmail: "priya@x.test",
                  charactersAdded: 120,
                  charactersRemoved: 0,
                  excerpt: "Owner: Priya Raman",
                  approximate: true,
                },
              ],
              renamed: [],
              unchangedCount: 3,
            },
          },
        }),
      ).prompt,
    );

    // "It rewrote a colleague's brief" and "it finished its own draft" are
    // different findings off an otherwise identical row.
    expect(section).toContain('~ edited "Q3 brief" (owner priya@x.test) +120 characters');
    expect(section).toContain('+ created "Handover" owned by sam@x.test');
    // A net count read as an exact one understates what the agent wrote.
    expect(section).toContain("NET of a document captured only in part");
  });
});

describe("fitLines", () => {
  it("keeps a list that fits, byte for byte", () => {
    const lines = ["a", "b", "c"];
    expect(fitLines(lines, 1000, "row")).toEqual({ text: "a\nb\nc", shown: 3, total: 3 });
  });

  it("keeps both endpoints even when the budget only pays for two rows", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `row ${i}`);
    const fitted = fitLines(lines, 1, "row");
    expect(fitted.shown).toBe(2);
    expect(fitted.text.startsWith("row 0")).toBe(true);
    expect(fitted.text.endsWith("row 99")).toBe(true);
    expect(fitted.text).toContain("… 98 rows not shown here …");
  });

  it("says nothing about gaps when there are none", () => {
    expect(fitLines(["only"], 1000, "row").text).toBe("only");
  });
});

/** Every object node the provider will validate, found wherever it is nested. */
function objectNodes(node: unknown, path: string, out: Array<{ path: string; node: Record<string, unknown> }>): void {
  if (!node || typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  if (rec.type === "object") out.push({ path, node: rec });
  for (const [key, value] of Object.entries(rec)) {
    if (Array.isArray(value)) value.forEach((v, i) => objectNodes(v, `${path}.${key}[${i}]`, out));
    else objectNodes(value, `${path}.${key}`, out);
  }
}

describe("EPISODE_JUDGE_SCHEMA", () => {
  it("is strict at every depth, not just the root", () => {
    const nodes: Array<{ path: string; node: Record<string, unknown> }> = [];
    objectNodes(EPISODE_JUDGE_SCHEMA, "$", nodes);
    expect(nodes.length).toBeGreaterThan(3);

    for (const { path, node } of nodes) {
      expect(node.additionalProperties, `${path} allows extra properties`).toBe(false);
      const properties = Object.keys((node.properties ?? {}) as Record<string, unknown>);
      const required = (node.required ?? []) as string[];
      // Strict json_schema rejects a schema whose `required` is not exactly its
      // property list — an optional field has to be modelled with a sentinel.
      expect([...required].sort(), `${path} required != properties`).toEqual(properties.sort());
    }
  });

  it("asks for the task restatement before the verdict, since order is generation order", () => {
    const keys = Object.keys(EPISODE_JUDGE_SCHEMA.properties as Record<string, unknown>);
    expect(keys[0]).toBe("taskUnderstanding");
    expect(keys.indexOf("taskUnderstanding")).toBeLessThan(keys.indexOf("summary"));
    expect(keys.indexOf("taskUnderstanding")).toBeLessThan(keys.indexOf("findings"));
  });

  it("constrains findings to catalog ids", () => {
    const properties = EPISODE_JUDGE_SCHEMA.properties as Record<string, { items?: unknown }>;
    const items = properties.findings.items as { properties: { mode: { enum: string[] } } };
    expect(items.properties.mode.enum).toContain("stalled");
    expect(items.properties.mode.enum).toContain("cross-surface-inconsistency");
  });
});
