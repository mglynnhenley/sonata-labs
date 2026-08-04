import { completeJSON, DEFAULT_MODEL, type Effort } from "../llm";
import { withRole } from "../trace";
import { isFailureModeId } from "./failureModes";
import { buildJudgePrompt, JUDGE_REPORT_SCHEMA } from "./prompt";
import type { Finding, JudgeInput, JudgeReport } from "./types";

// The judge's single model call. Everything upstream of it is pure (`./prompt`,
// `./project`) and everything downstream is I/O (`./store`) — which is what lets a
// saved run be re-judged with a different model or a rewritten prompt, offline,
// without an agent ever running again.

/** The fields the model is asked for. The other three are stamped here. */
type JudgeResponse = Omit<JudgeReport, "runId" | "judgedAt" | "model">;

export interface JudgeOptions {
  model?: string;
  effort?: Effort;
}

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  critical: 3,
  major: 2,
  minor: 1,
};

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
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
  target.evidence = unique([...target.evidence, ...(extra.evidence ?? [])]);
  const seq = unique([...(target.seq ?? []), ...(extra.seq ?? [])]).sort((a, b) => a - b);
  if (seq.length > 0) target.seq = seq;
}

/**
 * Reconcile the model's findings with the catalog. Two things go wrong in practice
 * and neither is worth failing a run over: an id that is not in the catalog
 * (hallucinated, or renamed since the artifact was written) and the same mode
 * reported twice with different evidence, which makes "bulk-swept fired in 6 of 20
 * runs" a lie. Unknown ids are demoted to `otherFindings` rather than dropped —
 * an uncatalogued id is precisely the signal that the catalog needs an entry.
 */
function reconcile(raw: JudgeResponse): Pick<JudgeReport, "findings" | "otherFindings"> {
  const byMode = new Map<string, Finding>();
  const otherFindings = [...(raw.otherFindings ?? [])];

  for (const f of raw.findings ?? []) {
    if (!isFailureModeId(f.mode)) {
      otherFindings.push({
        label: f.mode,
        severity: f.severity,
        evidence: f.evidence ?? [],
      });
      continue;
    }
    let merged = byMode.get(f.mode);
    if (!merged) {
      merged = { mode: f.mode, severity: f.severity, evidence: [] };
      byMode.set(f.mode, merged);
    }
    mergeInto(merged, f);
  }

  return { findings: [...byMode.values()], otherFindings };
}

/**
 * Judge one run. Pure in the sense that matters here: no files, no mailbox, no
 * clock beyond the stamp — so the same `JudgeInput` judged twice is comparable.
 */
export async function judge(input: JudgeInput, opts: JudgeOptions = {}): Promise<JudgeReport> {
  const { system, prompt } = buildJudgePrompt(input);
  const model = opts.model ?? DEFAULT_MODEL;

  // `withRole` is not optional even though this is usually a standalone pass: run
  // inline, the judge executes inside the agent's `withTrace` scope, where an
  // un-roled call is recorded as the agent's own — corrupting the trace it judges.
  const raw = await withRole("judge", () =>
    completeJSON<JudgeResponse>({
      system,
      prompt,
      schema: JUDGE_REPORT_SCHEMA as unknown as Record<string, unknown>,
      schemaName: "judge_report",
      model,
      // Diagnosis is the whole product here, so this is never the call to economise on.
      effort: opts.effort ?? "high",
    }),
  );

  return {
    ...raw,
    ...reconcile(raw),
    runId: input.runId,
    judgedAt: Date.now(),
    model,
  };
}
