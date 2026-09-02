import { describe, it, expect } from "vitest";
import type { AgentStep } from "@sonata/core";
import { auditKey, pairRowsToSteps } from "../src/trace";
import { auditRefName } from "../src/director";
import { auditRow } from "./fixtures";

// Which of the agent's steps wrote which audit row. Two things downstream are
// wrong in the same way if this slips: the director is quoted the wrong body back
// at it, and `DirectorEvent.becauseSeq` draws a causal arrow to the wrong step.
// So the pairing has one implementation and this is where it is pinned.

const wrote = (seq: number, twin: "gmail" | "slack", over: Partial<AgentStep> = {}): AgentStep =>
  ({
    kind: "tool",
    seq,
    at: 0,
    twin,
    name: "send",
    args: { body: `body ${seq}` },
    resultSummary: "sent",
    isMutation: true,
    ...over,
  }) as AgentStep;

const seqsFor = (map: Map<string, AgentStep>): Array<[string, number]> =>
  [...map.entries()].map(([key, step]) => [key, step.seq]);

describe("pairRowsToSteps", () => {
  it("pairs a twin's rows to that twin's mutations, in order", () => {
    const map = pairRowsToSteps(
      [wrote(0, "gmail"), wrote(1, "gmail")],
      [auditRow({ id: 4, twin: "gmail" }), auditRow({ id: 5, twin: "gmail" })],
    );
    expect(seqsFor(map)).toEqual([
      ["gmail:4", 0],
      ["gmail:5", 1],
    ]);
  });

  it("pairs per twin, because three id sequences interleave arbitrarily", () => {
    // Interleaved by seq — gmail, slack, gmail — and the ids do not agree with
    // that order. Pairing across twins would hand the slack row a gmail body.
    const map = pairRowsToSteps(
      [wrote(0, "gmail"), wrote(1, "slack"), wrote(2, "gmail")],
      [
        auditRow({ id: 1, twin: "slack" }),
        auditRow({ id: 8, twin: "gmail" }),
        auditRow({ id: 9, twin: "gmail" }),
      ],
    );
    expect(seqsFor(map).sort()).toEqual([
      ["gmail:8", 0],
      ["gmail:9", 2],
      ["slack:1", 1],
    ]);
  });

  it("does not collapse two twins' rows that happen to share an id", () => {
    // Each twin's `action_log` is its own AUTOINCREMENT, so all three sequences
    // start at 1 and overlap for the whole run: the first tick in which the agent
    // both emails the client and posts in #ops has gmail row 1 AND slack row 1.
    // Keyed on the number alone, one silently overwrites the other and the world
    // is quoted the Slack one-liner as the body of the email — an agent that DID
    // send the credit figure then gets escalated at for withholding it.
    const map = pairRowsToSteps(
      [wrote(3, "gmail"), wrote(5, "slack")],
      [auditRow({ id: 1, twin: "gmail" }), auditRow({ id: 1, twin: "slack" })],
    );
    expect(seqsFor(map).sort()).toEqual([
      ["gmail:1", 3],
      ["slack:1", 5],
    ]);
  });

  it("ignores steps that wrote no row", () => {
    const map = pairRowsToSteps(
      [
        { kind: "thought", seq: 0, at: 0, text: "planning" },
        wrote(1, "gmail", { isMutation: false }),
        wrote(2, "gmail", { error: "twin returned 500" }),
        { kind: "escalation", seq: 3, at: 0, text: "over to you" },
        wrote(4, "gmail"),
      ],
      [auditRow({ id: 7, twin: "gmail" })],
    );
    expect(seqsFor(map)).toEqual([["gmail:7", 4]]);
  });

  it("keeps the TAIL when a backlog of rows arrives at once", () => {
    // A twin that could not be read for a tick reports both ticks' rows on the
    // next read. Only the last of them belongs to the steps being held, and
    // aligning from the start would put the previous tick's words in the world's
    // mouth — the exact class of error this whole change exists to remove.
    const map = pairRowsToSteps(
      [wrote(9, "gmail")],
      [auditRow({ id: 4, twin: "gmail" }), auditRow({ id: 5, twin: "gmail" })],
    );
    expect(seqsFor(map)).toEqual([["gmail:5", 9]]);
  });

  it("keys on the same string the director's refs are built from", () => {
    // `auditRefName` is `act:` + this, so a key that drifted from it would look
    // up prose under a name the prompt never offered.
    expect(auditKey(auditRow({ id: 4, twin: "gmail" }))).toBe("gmail:4");
    expect(auditRefName(auditRow({ id: 4, twin: "gmail" }))).toBe(`act:${auditKey(auditRow({ id: 4, twin: "gmail" }))}`);
  });

  it("pairs nothing rather than guessing when there is nothing to pair with", () => {
    expect(pairRowsToSteps([], [auditRow({ id: 1, twin: "gmail" })]).size).toBe(0);
    expect(pairRowsToSteps([wrote(0, "gmail")], []).size).toBe(0);
    // A row from a twin the agent never touched this tick stays unattributed.
    expect(pairRowsToSteps([wrote(0, "slack")], [auditRow({ id: 1, twin: "gmail" })]).size).toBe(0);
  });
});
