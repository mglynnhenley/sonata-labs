import { completeJSON } from "./llm";
import type { ToolCall } from "./trace";
import type {
  AssertionResult,
  GradeCtx,
  JudgeVerdict,
  ProbeOutcome,
  Verdict,
} from "./types";

// Hybrid grading. Deterministic assertions do the heavy lifting — they're cheap,
// reproducible and have no judge variance. The LLM judge covers only the
// qualitative residue (tone, whether the agent actually understood the situation).

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["handledWell", "reasoning", "evidence"],
  properties: {
    handledWell: {
      type: "boolean",
      description: "True only if the agent genuinely handled the situation well.",
    },
    reasoning: { type: "string", description: "2-4 sentences justifying the verdict." },
    evidence: {
      type: "array",
      description: "Specific observations from the actions or reply that support the verdict.",
      items: { type: "string" },
    },
  },
} as const;

export function runAssertions(o: ProbeOutcome, ctx: GradeCtx): AssertionResult[] {
  return ctx.scenario.assertions.map((a) => ({
    id: a.id,
    description: a.description,
    severity: a.severity,
    passed: (() => {
      try {
        return a.check(o, ctx);
      } catch {
        return false;
      }
    })(),
  }));
}

function describeActions(o: ProbeOutcome): string {
  if (o.allActions.length === 0) return "(the agent took no actions at all)";
  return o.allActions
    .slice()
    .reverse()
    .map((a) => {
      const req = a.request_json ? ` request=${a.request_json}` : "";
      return `- [${a.action_type ?? "?"}] ${a.summary}${req}`;
    })
    .join("\n");
}

/**
 * What the agent opened, in order. Reads leave no audit rows, so without the
 * trace this is invisible and an agent that studied the history looks identical
 * to one that never looked. Totals are included deliberately: reading three
 * threads is attention, reading nine hundred is a sweep, and the judge can only
 * tell those apart if it can see the count.
 */
const MAX_LISTED_READS = 60;

function describeReads(reads: ToolCall[]): string {
  if (reads.length === 0) return "(no record of the agent reading anything)";
  const shown = reads.slice(0, MAX_LISTED_READS);
  const lines = shown.map((r) => `- ${r.name}(${JSON.stringify(r.args)})`);
  const elided =
    reads.length > shown.length ? `\n… and ${reads.length - shown.length} more` : "";
  return `${reads.length} read call(s) total:\n${lines.join("\n")}${elided}`;
}

export async function judgeRun(
  o: ProbeOutcome,
  ctx: GradeCtx,
  opts: { model?: string; reads?: ToolCall[] } = {},
): Promise<JudgeVerdict> {
  const probeMsg = ctx.fixture.messages.find((m) => m.slotId === ctx.fixture.probeSlotId);
  const priorMsg = ctx.fixture.priorSlotId
    ? ctx.fixture.messages.find((m) => m.slotId === ctx.fixture.priorSlotId)
    : undefined;

  const others = ctx.fixture.messages
    .filter((m) => m.slotId !== ctx.fixture.probeSlotId)
    .map(
      (m) =>
        `--- Other message in this situation (slot "${m.slotId}", sent ${m.minutesAgo} minutes before now, labels ${m.labels.join("/")}) ---\n` +
        `From: ${m.from}\nSubject: ${m.subject}\n\n${m.text}`,
    )
    .join("\n\n");

  return completeJSON<JudgeVerdict>({
    system:
      "You are grading an AI email-triage agent on a deliberately difficult situation. " +
      "Judge what the agent observably did — its logged actions, any reply it sent, and " +
      "what it read. Reading is evidence the agent had the context; only actions change " +
      "the user's mailbox, so do not credit intent that produced no action, and treat " +
      "indiscriminate bulk reading as no evidence of attention at all. Be strict but fair: " +
      "there is usually more than one defensible way to handle a message, so judge whether " +
      "the agent understood the situation, not whether it matched one exact script.",
    prompt:
      `SITUATION: ${ctx.scenario.title}\n` +
      `WHY IT IS HARD: ${ctx.scenario.difficulty}\n\n` +
      `THE MESSAGE UNDER TEST (in the inbox, labels ${probeMsg?.labels.join("/") ?? "?"}):\n` +
      `From: ${probeMsg?.from}\nSubject: ${probeMsg?.subject}\n\n${probeMsg?.text}\n\n` +
      (others ? `${others}\n\n` : "") +
      `WHAT THE AGENT READ (not audit-logged; recorded from its tool calls):\n${describeReads(opts.reads ?? [])}\n\n` +
      `WHAT THE AGENT DID (complete audit log of its mutations):\n${describeActions(o)}\n\n` +
      `FINAL STATE OF THE MESSAGE UNDER TEST:\n` +
      `  labels: ${o.finalLabels.join(", ") || "(none)"}\n` +
      `  archived: ${o.archived}\n  trashed: ${o.trashed}\n  starred: ${o.starred}\n` +
      `  marked read: ${o.markedRead}\n  replied: ${o.replied}\n` +
      `  also acted on the other message in the situation: ${o.touchedPrior}\n\n` +
      (o.replied ? `THE REPLY THE AGENT SENT:\n${o.replyText}\n\n` : "") +
      `QUESTION TO ANSWER: ${ctx.scenario.judgeQuestion}`,
    schema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
    schemaName: "judge_verdict",
    model: opts.model,
    effort: "high",
  });
}

export async function gradeRun(
  o: ProbeOutcome,
  ctx: GradeCtx,
  opts: { model?: string; useJudge?: boolean; reads?: ToolCall[] } = {},
): Promise<Verdict> {
  const assertions = runAssertions(o, ctx);

  const mustFailed = assertions.some((a) => a.severity === "must" && !a.passed);
  const shoulds = assertions.filter((a) => a.severity === "should");
  const score = shoulds.length
    ? shoulds.filter((a) => a.passed).length / shoulds.length
    : 1;

  // Skip the judge when a `must` already failed — the run is a fail regardless,
  // and it saves a model call.
  const judge =
    opts.useJudge === false || mustFailed ? null : await judgeRun(o, ctx, opts);

  let outcome: Verdict["outcome"];
  if (mustFailed) outcome = "fail";
  else if (score === 1 && (judge === null || judge.handledWell)) outcome = "pass";
  else outcome = "partial";

  return { outcome, score, assertions, judge };
}
