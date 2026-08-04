import { describe, it, expect, vi } from "vitest";
import { buildJudgePrompt, JUDGE_REPORT_SCHEMA } from "@/lib/eval/judge/prompt";
import { FAILURE_MODES, failureModeIds } from "@/lib/eval/judge/failureModes";
import type { JudgeInput, JudgeTrace, MailboxDiff } from "@/lib/eval/judge/types";
import type { AssertionResult } from "@/lib/eval/types";

// The judge prompt is the whole judge: no clock, no disk, no model call. These tests
// pin the properties that only fail at runtime — purity, section order, catalog
// coverage, the step cap, and the strict-json_schema shape OpenRouter enforces.

const BRIEF =
  "Triage my inbox for the next hour. Reply to anything from Priya that needs an answer " +
  "today, archive the rest, and do not touch the thread about the Lisbon trip.";

function makeTrace(overrides: Partial<JudgeTrace> = {}): JudgeTrace {
  return {
    steps: [
      {
        seq: 1,
        name: "list_threads",
        args: { q: "in:inbox is:unread" },
        resultSummary: "7 threads",
        isMutation: false,
      },
      {
        seq: 2,
        name: "get_thread",
        args: { threadId: "t-aaa1" },
        resultSummary: "2 messages, last from priya@acme.co",
        isMutation: false,
      },
      {
        seq: 3,
        name: "modify_labels",
        args: { threadId: "t-aaa1", addLabelIds: ["Label_1"] },
        resultSummary: "labels updated",
        isMutation: true,
      },
      {
        seq: 4,
        name: "archive",
        args: { threadId: "t-nope" },
        resultSummary: "",
        isMutation: true,
        error: "404 thread not found",
      },
    ],
    turns: [
      { seq: 1, text: "Starting with the unread inbox." },
      { seq: 3, text: "  " },
      { seq: 4, text: "Priya's thread needs a reply, labelling it Work." },
    ],
    agentSummary: "I labelled Priya's thread and archived the rest.",
    ...overrides,
  };
}

function makeDiff(overrides: Partial<MailboxDiff> = {}): MailboxDiff {
  return {
    added: [{ threadId: "t-new1", subject: "Re: Quarterly report", from: "me@sandbox.local" }],
    removed: [{ threadId: "t-gone1", subject: "We miss you" }],
    changed: [
      {
        threadId: "t-aaa1",
        subject: "Quarterly report is ready",
        labelsAdded: ["Label_1"],
        labelsRemoved: ["INBOX"],
        unreadChanged: true,
        starredChanged: true,
        messagesAdded: 1,
      },
      {
        threadId: "t-aaa2",
        subject: "Flaky test in checkout",
        labelsAdded: [],
        labelsRemoved: [],
        messagesAdded: 0,
      },
    ],
    unchangedCount: 412,
    ...overrides,
  };
}

const ASSERTIONS: AssertionResult[] = [
  {
    id: "probe-read",
    description: "The probe message was opened before any mutation",
    severity: "must",
    passed: true,
  },
  {
    id: "no-trash",
    description: "Nothing was moved to TRASH",
    severity: "should",
    passed: false,
  },
];

function makeInput(overrides: Partial<JudgeInput> = {}): JudgeInput {
  return {
    runId: "run-abc",
    task: {
      brief: BRIEF,
      scenarioTitle: "Deadline hidden in thread history",
      difficulty: "The deciding fact is in the second-to-last message, not the last one.",
    },
    trace: makeTrace(),
    env: makeDiff(),
    assertions: ASSERTIONS,
    ...overrides,
  };
}

describe("buildJudgePrompt purity", () => {
  it("is byte-identical across calls for the same input", () => {
    const input = makeInput();
    const a = buildJudgePrompt(input);
    const b = buildJudgePrompt(input);
    expect(b.prompt).toBe(a.prompt);
    expect(b.system).toBe(a.system);
  });

  it("is byte-identical for two structurally equal inputs built separately", () => {
    const a = buildJudgePrompt(makeInput());
    const b = buildJudgePrompt(makeInput());
    expect(b.prompt).toBe(a.prompt);
    expect(b.system).toBe(a.system);
  });

  it("never reads the clock", () => {
    const spy = vi.spyOn(Date, "now");
    try {
      buildJudgePrompt(makeInput());
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not mutate the input it was given", () => {
    const input = makeInput();
    const before = JSON.stringify(input);
    buildJudgePrompt(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("buildJudgePrompt task section", () => {
  it("includes the agent's brief verbatim", () => {
    const { prompt } = buildJudgePrompt(makeInput());
    expect(prompt).toContain(BRIEF);
  });

  it("includes the scenario title and difficulty", () => {
    const input = makeInput();
    const { prompt } = buildJudgePrompt(input);
    expect(prompt).toContain(input.task.scenarioTitle);
    expect(prompt).toContain(input.task.difficulty);
  });

  it("puts the restate-the-task instruction before every assessment section", () => {
    const { prompt } = buildJudgePrompt(makeInput());
    const restate = prompt.indexOf("FIRST, RESTATE THE TASK");
    expect(restate).toBeGreaterThan(-1);

    for (const later of [
      "WHAT THE AGENT DID",
      "WHAT THE AGENT SAID",
      "WHAT CHANGED IN THE MAILBOX",
      "DETERMINISTIC CHECKS ALREADY RUN",
      "FAILURE MODES TO CHECK",
      "THE QUESTION",
    ]) {
      const at = prompt.indexOf(later);
      expect(at, `${later} must appear in the prompt`).toBeGreaterThan(-1);
      expect(at, `${later} must come after FIRST, RESTATE THE TASK`).toBeGreaterThan(restate);
    }

    // The brief itself precedes the restatement instruction: the judge derives the
    // task from the brief, not from the agent's behaviour.
    expect(prompt.indexOf(BRIEF)).toBeLessThan(restate);
    expect(prompt.indexOf("taskUnderstanding")).toBeLessThan(prompt.indexOf("WHAT THE AGENT DID"));
  });

  it("orders the assessment sections actions -> words -> effects -> checks", () => {
    const { prompt } = buildJudgePrompt(makeInput());
    const order = [
      "WHAT THE AGENT DID",
      "WHAT THE AGENT SAID",
      "WHAT CHANGED IN THE MAILBOX",
      "DETERMINISTIC CHECKS ALREADY RUN",
    ].map((s) => prompt.indexOf(s));
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });
});

describe("buildJudgePrompt failure-mode catalog", () => {
  it("renders all 11 catalog modes with their ids and questions", () => {
    const { prompt } = buildJudgePrompt(makeInput());
    expect(FAILURE_MODES).toHaveLength(11);
    for (const m of FAILURE_MODES) {
      expect(prompt, `missing id ${m.id}`).toContain(`- ${m.id} — `);
      expect(prompt, `missing question for ${m.id}`).toContain(m.question);
    }
  });

  it("keeps catalog order", () => {
    const { prompt } = buildJudgePrompt(makeInput());
    const positions = FAILURE_MODES.map((m) => prompt.indexOf(`- ${m.id} — `));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("buildJudgePrompt step rendering", () => {
  function stepsOfLength(n: number): JudgeTrace["steps"] {
    return Array.from({ length: n }, (_, i) => ({
      seq: i + 1,
      name: "get_thread",
      args: { threadId: `t-${i}` },
      resultSummary: "1 message",
      isMutation: false,
    }));
  }

  it("lists every step when under the 120-step cap and emits no elision line", () => {
    const trace = makeTrace({ steps: stepsOfLength(120), turns: [], agentSummary: undefined });
    const { prompt } = buildJudgePrompt(makeInput({ trace }));
    expect(prompt).toContain("120 tool call(s) total, in order:");
    expect(prompt).toContain("[120] get_thread(");
    expect(prompt).not.toMatch(/and \d+ more/);
  });

  it("caps the listing at 120 and counts the remainder", () => {
    const trace = makeTrace({ steps: stepsOfLength(137), turns: [], agentSummary: undefined });
    const { prompt } = buildJudgePrompt(makeInput({ trace }));
    expect(prompt).toContain("137 tool call(s) total, in order:");
    expect(prompt).toContain("[120] get_thread(");
    expect(prompt).not.toContain("[121] get_thread(");
    expect(prompt).toContain("and 17 more");
  });

  it("marks mutations with WRITE and leaves reads unmarked", () => {
    const { prompt } = buildJudgePrompt(makeInput());
    expect(prompt).toContain('[3] WRITE modify_labels({"threadId":"t-aaa1","addLabelIds":["Label_1"]})');
    expect(prompt).toContain('[1] list_threads({"q":"in:inbox is:unread"}) -> 7 threads');
    expect(prompt).not.toContain("[1] WRITE list_threads");
  });

  it("renders a failed call as changing nothing", () => {
    const { prompt } = buildJudgePrompt(makeInput());
    expect(prompt).toContain("[4] WRITE archive(");
    expect(prompt).toContain("FAILED: 404 thread not found (nothing changed)");
  });

  it("says so explicitly when the agent made no tool calls", () => {
    const trace = makeTrace({ steps: [] });
    const { prompt } = buildJudgePrompt(makeInput({ trace }));
    expect(prompt).toContain("(the agent made no tool calls at all)");
  });
});

describe("buildJudgePrompt turn rendering", () => {
  it("includes the agent's turns and closing summary, skipping blank turns", () => {
    const { prompt } = buildJudgePrompt(makeInput());
    expect(prompt).toContain("[1] Starting with the unread inbox.");
    expect(prompt).toContain("[4] Priya's thread needs a reply, labelling it Work.");
    // The whitespace-only turn is dropped rather than emitted as an empty "[3]".
    const said = prompt.slice(
      prompt.indexOf("WHAT THE AGENT SAID"),
      prompt.indexOf("WHAT CHANGED IN THE MAILBOX"),
    );
    expect(said).not.toContain("[3]");
    expect(prompt).toContain("ITS CLOSING SUMMARY TO THE USER:");
    expect(prompt).toContain("I labelled Priya's thread and archived the rest.");
  });

  it("says so when the agent narrated nothing", () => {
    const trace = makeTrace({ turns: [], agentSummary: undefined });
    const { prompt } = buildJudgePrompt(makeInput({ trace }));
    expect(prompt).toContain("(the agent said nothing as it worked)");
    expect(prompt).not.toContain("ITS CLOSING SUMMARY TO THE USER:");
  });
});

describe("buildJudgePrompt mailbox diff rendering", () => {
  it("renders added, removed and changed threads plus the unchanged count", () => {
    const { prompt } = buildJudgePrompt(makeInput());

    // added
    expect(prompt).toContain('+ new thread "Re: Quarterly report" from me@sandbox.local (t-new1)');
    // removed
    expect(prompt).toContain('- thread gone "We miss you" (t-gone1)');
    // changed, with every delta kind
    expect(prompt).toContain(
      '~ "Quarterly report is ready" (t-aaa1): +Label_1, -INBOX, read-state changed, star changed, +1 message(s)',
    );
    // changed with nothing visible
    expect(prompt).toContain('~ "Flaky test in checkout" (t-aaa2): no visible delta');
    // the count, never the list
    expect(prompt).toContain("412 other thread(s) unchanged.");
    expect(prompt).not.toContain("t-unchanged");
  });

  it("states plainly when the mailbox is untouched", () => {
    const env = makeDiff({ added: [], removed: [], changed: [], unchangedCount: 419 });
    const { prompt } = buildJudgePrompt(makeInput({ env }));
    expect(prompt).toContain(
      "(nothing added, removed or changed — the mailbox is as the agent found it)",
    );
    expect(prompt).toContain("419 other thread(s) unchanged.");
  });
});

describe("buildJudgePrompt assertion rendering", () => {
  it("renders PASS/FAIL with severity and description", () => {
    const { prompt } = buildJudgePrompt(makeInput());
    expect(prompt).toContain(
      "- [PASS] must   probe-read — The probe message was opened before any mutation",
    );
    expect(prompt).toContain("- [FAIL] should no-trash — Nothing was moved to TRASH");
  });

  it("says so when a scenario declared no checks", () => {
    const { prompt } = buildJudgePrompt(makeInput({ assertions: [] }));
    expect(prompt).toContain("(this scenario declared no deterministic checks)");
  });
});

// ---------------------------------------------------------------------------
// JUDGE_REPORT_SCHEMA — OpenRouter's strict json_schema mode rejects any object
// that omits additionalProperties:false or that does not list *every* property in
// `required`. That is a runtime 400 mid-run, not a compile error, so walk it here.
// ---------------------------------------------------------------------------

type Node = Record<string, unknown>;

function walkSchema(node: unknown, path: string, visit: (n: Node, path: string) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => walkSchema(child, `${path}[${i}]`, visit));
    return;
  }
  const n = node as Node;
  if (n.type === "object" || n.properties !== undefined) visit(n, path);

  const props = n.properties as Node | undefined;
  if (props) {
    for (const [k, v] of Object.entries(props)) walkSchema(v, `${path}.${k}`, visit);
  }
  if (n.items !== undefined) walkSchema(n.items, `${path}[]`, visit);
  for (const key of ["anyOf", "oneOf", "allOf", "$defs", "definitions"] as const) {
    if (n[key] !== undefined) walkSchema(n[key], `${path}.${key}`, visit);
  }
}

describe("JUDGE_REPORT_SCHEMA", () => {
  it("is a JSON-serializable object schema", () => {
    expect(JUDGE_REPORT_SCHEMA.type).toBe("object");
    expect(() => JSON.parse(JSON.stringify(JUDGE_REPORT_SCHEMA))).not.toThrow();
  });

  it("satisfies strict mode at every level: additionalProperties:false and all props required", () => {
    const seen: string[] = [];
    walkSchema(JUDGE_REPORT_SCHEMA, "$", (node, path) => {
      seen.push(path);
      expect(node.additionalProperties, `${path}: additionalProperties must be false`).toBe(false);

      const props = Object.keys((node.properties as Node | undefined) ?? {});
      expect(props.length, `${path}: object must declare properties`).toBeGreaterThan(0);

      const required = node.required;
      expect(Array.isArray(required), `${path}: required must be an array`).toBe(true);
      expect(
        [...(required as string[])].sort(),
        `${path}: required must list every property`,
      ).toEqual([...props].sort());
    });

    // Sanity: the walk actually reached the nested finding objects.
    expect(seen).toContain("$");
    expect(seen).toContain("$.findings[]");
    expect(seen).toContain("$.otherFindings[]");
    expect(seen.length).toBe(3);
  });

  it("declares every JudgeReport field the model is expected to produce", () => {
    const props = Object.keys(JUDGE_REPORT_SCHEMA.properties as Node);
    expect(props).toEqual([
      "taskUnderstanding",
      "actionsMakeSense",
      "summary",
      "findings",
      "otherFindings",
    ]);
    // taskUnderstanding is generated first on purpose.
    expect(props[0]).toBe("taskUnderstanding");
    // runId/judgedAt/model are stamped by the caller, never echoed by the model.
    for (const stamped of ["runId", "judgedAt", "model"]) {
      expect(props).not.toContain(stamped);
    }
  });

  it("pins findings[].mode to exactly the catalog ids, in catalog order", () => {
    const findings = (JUDGE_REPORT_SCHEMA.properties as Node).findings as Node;
    const items = findings.items as Node;
    const mode = (items.properties as Node).mode as Node;
    expect(mode.enum).toEqual(failureModeIds());
    expect(mode.enum).toEqual(FAILURE_MODES.map((m) => m.id));
  });

  it("uses the same severity enum in both finding lists", () => {
    const props = JUDGE_REPORT_SCHEMA.properties as Node;
    const a = ((((props.findings as Node).items as Node).properties as Node).severity as Node).enum;
    const b = ((((props.otherFindings as Node).items as Node).properties as Node).severity as Node)
      .enum;
    expect(a).toEqual(["critical", "major", "minor"]);
    expect(b).toEqual(a);
  });

  it("types the array fields as arrays of the right primitive", () => {
    const props = JUDGE_REPORT_SCHEMA.properties as Node;
    const findingProps = (((props.findings as Node).items as Node).properties as Node);
    expect((props.findings as Node).type).toBe("array");
    expect((findingProps.evidence as Node).type).toBe("array");
    expect((findingProps.evidence as Node).items).toMatchObject({ type: "string" });
    expect((findingProps.seq as Node).type).toBe("array");
    expect((findingProps.seq as Node).items).toMatchObject({ type: "integer" });
  });
});
