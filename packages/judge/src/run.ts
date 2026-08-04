import {
  isFailureModeId,
  type EpisodeJudgeInput,
  type EpisodeJudgeReport,
  type Finding,
  type OtherFinding,
  type Severity,
  type TraceRole,
} from "@sonata/core";
import { buildEpisodePrompt, EPISODE_JUDGE_SCHEMA } from "./prompt";

// The judge's single model call. Everything upstream of it is pure (`./prompt`,
// `./project`, `./checklist`, `./autonomy`) and everything downstream is I/O
// (`./store`) — which is what lets a saved run be re-judged with a different model
// or a rewritten prompt, offline, without an agent ever running again.

/**
 * The structured-completion port.
 *
 * The judge does not own an HTTP client. `apps/gmail/src/lib/eval/llm.ts`'s
 * `completeJSON` already satisfies this signature exactly, so wiring is
 * `judge(input, { complete: completeJSON })` — and in tests it is a two-line stub,
 * which is why every test in this package runs offline with no key.
 */
export interface CompleteJSON {
  <T>(opts: {
    system?: string;
    prompt: string;
    schema: Record<string, unknown>;
    schemaName?: string;
    model?: string;
    effort?: JudgeEffort;
    maxTokens?: number;
  }): Promise<T>;
}

export type JudgeEffort = "low" | "medium" | "high";

/** `withRole` from the harness's trace module — see `opts.withRole` for why. */
export type WithRole = <T>(role: TraceRole, fn: () => Promise<T>) => Promise<T>;

export interface JudgeOptions {
  complete: CompleteJSON;
  model?: string;
  /** Diagnosis is the whole product here, so this is never the call to economise on. */
  effort?: JudgeEffort;
  /**
   * Wrap the model call so the trace attributes it to the judge.
   *
   * Not optional in spirit even though it is in the type: run inline, the judge
   * executes inside the engine's own trace scope, where an un-roled call is recorded
   * as the agent's — corrupting the very trace it is judging. Omit it only when
   * judging offline, outside any trace.
   */
  withRole?: WithRole;
  /** Injected so a re-judge of the same input is byte-comparable in tests. */
  now?: () => number;
}

/** The fields the model is asked for. The other three are stamped here. */
type JudgeResponse = Omit<EpisodeJudgeReport, "runId" | "judgedAt" | "model">;

const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1 };

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function clamp01(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** -1 is the schema's "no single tick applies"; so is anything non-integral. */
function tickOf(tick: unknown): number | undefined {
  return typeof tick === "number" && Number.isInteger(tick) && tick >= 0 ? tick : undefined;
}

function severityOf(s: unknown): Severity {
  return s === "critical" || s === "major" || s === "minor" ? s : "minor";
}

function evidenceOf(e: unknown): string[] {
  return Array.isArray(e) ? e.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Fold `extra` into `target`. One mode is one finding, so the worst severity wins
 * and both sets of evidence survive — dropping either loses a real observation the
 * model made, and the `seq` links are what the UI uses to jump to the step.
 */
function mergeInto(target: Finding, extra: Finding): void {
  if (SEVERITY_RANK[extra.severity] > SEVERITY_RANK[target.severity]) {
    target.severity = extra.severity;
  }
  target.evidence = unique([...target.evidence, ...extra.evidence]);
  const seq = unique([...(target.seq ?? []), ...(extra.seq ?? [])]).sort((a, b) => a - b);
  if (seq.length > 0) target.seq = seq;
  // Earliest tick wins: a mode reported twice is one behaviour, and the timeline
  // should scroll to where it started rather than to wherever it was last seen.
  if (target.tick === undefined || (extra.tick !== undefined && extra.tick < target.tick)) {
    if (extra.tick !== undefined) target.tick = extra.tick;
  }
}

/**
 * Reconcile the model's findings with the catalog. Two things go wrong in practice
 * and neither is worth failing a run over: an id that is not in the catalog
 * (hallucinated, or renamed since the artifact was written) and the same mode
 * reported twice with different evidence, which makes "bulk-swept fired in 6 of 20
 * runs" a lie. Unknown ids are demoted to `otherFindings` rather than dropped — an
 * uncatalogued id is precisely the signal that the catalog needs an entry.
 */
function reconcile(raw: JudgeResponse): Pick<EpisodeJudgeReport, "findings" | "otherFindings"> {
  const byMode = new Map<string, Finding>();
  const otherFindings: OtherFinding[] = (raw.otherFindings ?? []).map((o) => ({
    label: typeof o.label === "string" && o.label.trim() ? o.label : "unnamed finding",
    severity: severityOf(o.severity),
    evidence: evidenceOf(o.evidence),
    ...(tickOf(o.tick) === undefined ? {} : { tick: tickOf(o.tick) }),
  }));

  for (const f of raw.findings ?? []) {
    const severity = severityOf(f.severity);
    const evidence = evidenceOf(f.evidence);
    const tick = tickOf(f.tick);

    if (!isFailureModeId(f.mode)) {
      otherFindings.push({
        label: typeof f.mode === "string" && f.mode.trim() ? f.mode : "unnamed finding",
        severity,
        evidence,
        ...(tick === undefined ? {} : { tick }),
      });
      continue;
    }

    let merged = byMode.get(f.mode);
    if (!merged) {
      merged = { mode: f.mode, severity, evidence: [] };
      byMode.set(f.mode, merged);
    }
    mergeInto(merged, {
      mode: f.mode,
      severity,
      evidence,
      ...(tick === undefined ? {} : { tick }),
      seq: Array.isArray(f.seq) ? f.seq.filter((n): n is number => Number.isInteger(n)) : [],
    });
  }

  const findings = [...byMode.values()].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
  return { findings, otherFindings };
}

const UNANSWERED = "(the judge did not answer)";

/**
 * Line the answers back up with the questions that were asked.
 *
 * Models drop an entry, reorder them, or paraphrase the question back, and the
 * questions are known here, so the report is rebuilt from them rather than trusted.
 *
 * Echoed question text wins whenever the model echoed ANY of them, and position is
 * used only when it echoed none. Mixing the two is the trap: a model that answers
 * question 2 and silently drops question 1 returns a single entry, and falling back
 * to position for the unmatched question files that answer under question 1 —
 * attaching a real answer to the wrong question, which is worse than no answer.
 */
function alignAnswers(
  questions: string[],
  raw: JudgeResponse["answers"],
): EpisodeJudgeReport["answers"] {
  const given = Array.isArray(raw) ? raw : [];
  const asked = questions.map((q) => q.trim());
  const echoed = given.some((a) => asked.includes(a?.question?.trim() ?? ""));

  return questions.map((question, i) => {
    const match = echoed
      ? given.find((a) => a?.question?.trim() === question.trim())
      : given[i];
    const answer = match?.answer;
    return {
      question,
      answer: typeof answer === "string" && answer.trim() ? answer : UNANSWERED,
    };
  });
}

/**
 * Judge one day. Pure in the sense that matters here: no files, no twin, no clock
 * beyond the stamp — so the same `EpisodeJudgeInput` judged twice is comparable.
 */
export async function judge(
  input: EpisodeJudgeInput,
  opts: JudgeOptions,
): Promise<EpisodeJudgeReport> {
  const { system, prompt } = buildEpisodePrompt(input);
  const model = opts.model ?? DEFAULT_MODEL;
  const call = () =>
    opts.complete<JudgeResponse>({
      system,
      prompt,
      schema: EPISODE_JUDGE_SCHEMA,
      schemaName: "episode_judge_report",
      model,
      effort: opts.effort ?? "high",
    });

  const raw = opts.withRole ? await opts.withRole<JudgeResponse>("judge", call) : await call();

  return {
    runId: input.runId,
    judgedAt: (opts.now ?? Date.now)(),
    model,
    taskUnderstanding: typeof raw.taskUnderstanding === "string" ? raw.taskUnderstanding : "",
    autonomyScore: clamp01(raw.autonomyScore),
    summary: typeof raw.summary === "string" ? raw.summary : "",
    ...reconcile(raw),
    answers: alignAnswers(input.judgeQuestions, raw.answers),
  };
}
