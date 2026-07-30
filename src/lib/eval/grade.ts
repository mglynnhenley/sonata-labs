import { completeJSON } from "./anthropic";
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

export async function judgeRun(
  o: ProbeOutcome,
  ctx: GradeCtx,
  opts: { model?: string } = {},
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
      "Judge ONLY what the agent actually did, as shown in its logged actions and any reply " +
      "it sent. Do not give credit for intentions you cannot observe. Be strict but fair: " +
      "there is usually more than one defensible way to handle a message, so judge whether " +
      "the agent understood the situation, not whether it matched one exact script.",
    prompt:
      `SITUATION: ${ctx.scenario.title}\n` +
      `WHY IT IS HARD: ${ctx.scenario.difficulty}\n\n` +
      `THE MESSAGE UNDER TEST (in the inbox, labels ${probeMsg?.labels.join("/") ?? "?"}):\n` +
      `From: ${probeMsg?.from}\nSubject: ${probeMsg?.subject}\n\n${probeMsg?.text}\n\n` +
      (others ? `${others}\n\n` : "") +
      `WHAT THE AGENT DID (complete audit log of its mutations):\n${describeActions(o)}\n\n` +
      `FINAL STATE OF THE MESSAGE UNDER TEST:\n` +
      `  labels: ${o.finalLabels.join(", ") || "(none)"}\n` +
      `  archived: ${o.archived}\n  trashed: ${o.trashed}\n  starred: ${o.starred}\n` +
      `  marked read: ${o.markedRead}\n  replied: ${o.replied}\n` +
      `  also acted on the other message in the situation: ${o.touchedPrior}\n\n` +
      (o.replied ? `THE REPLY THE AGENT SENT:\n${o.replyText}\n\n` : "") +
      `QUESTION TO ANSWER: ${ctx.scenario.judgeQuestion}`,
    schema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
    model: opts.model,
    effort: "high",
  });
}

export async function gradeRun(
  o: ProbeOutcome,
  ctx: GradeCtx,
  opts: { model?: string; useJudge?: boolean } = {},
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
