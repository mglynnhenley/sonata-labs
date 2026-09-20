import { getFailureMode } from "@sonata/core";
import type { Assessment } from "@/lib/engine/assessments";
import { formatPercent, formatUsd, formatWhen } from "../_lib/summary";

export function AssessmentHistory({ assessments }: { assessments: Assessment[] }) {
  if (!assessments.length) return null;
  return <section className="rounded-sn-xl border border-sn-line bg-sn-surface p-5">
    <h2 className="text-sn-lg font-medium text-sn-ink">Assessment history</h2>
    <p className="mt-1 text-sn-sm text-sn-muted">Each judge reads the same recorded work. Earlier reports remain available. The main report shows the latest successful assessment.</p>
    <div className="mt-4 flex flex-col gap-3">
      {assessments.map(a => {
        const url = `/api/results/${encodeURIComponent(a.runId)}/assessments/${a.id}`;
        const incomplete = a.provenance.numericScoreEligible === false || a.report?.coverage?.complete === false;
        return <details key={a.id} className="rounded-sn-md border border-sn-line p-3">
          <summary className="cursor-pointer text-sn-sm text-sn-ink">
            {a.model} · {formatWhen(a.startedAt)} · {a.status}
            {a.report ? incomplete ? " · incomplete evidence, not scored" : ` · judge autonomy ${formatPercent(a.report.autonomyScore)}` : ""}
            {a.spend ? ` · ${formatUsd(a.spend.usd)}` : ""}
          </summary>
          <div className="mt-3 space-y-3 text-sn-sm text-sn-muted">
            <p>{a.runner === "inspect" ? "Assessed through Inspect." : "Historical assessment from before Inspect judging."}</p>
            {incomplete ? <p>The judge's explanation is available, but the evidence does not support a complete assessment score.</p> : null}
            {a.error ? <p role="alert">{a.error}</p> : null}
            {a.report ? <>
              <p className="font-medium text-sn-ink">{a.report.summary}</p>
              <p>{a.report.taskUnderstanding}</p>
              {a.report.taskPoints?.length ? <ul className="list-disc pl-5">{a.report.taskPoints.map((s, i) => <li key={i}>{s}</li>)}</ul> : null}
              {a.report.taskAmbiguities?.length ? <div><p>Unclear requirements</p><ul className="list-disc pl-5">{a.report.taskAmbiguities.map((s, i) => <li key={i}>{s}</li>)}</ul></div> : null}
              {a.report.did?.length ? <div><p>Completed</p><ul className="list-disc pl-5">{a.report.did.map((s, i) => <li key={i}>{s}</li>)}</ul></div> : null}
              {a.report.didNot?.length ? <div><p>Left undone</p><ul className="list-disc pl-5">{a.report.didNot.map((s, i) => <li key={i}>{s}</li>)}</ul></div> : null}
              {[...a.report.findings.map(f => ({ ...f, label: getFailureMode(f.mode)?.label ?? f.mode })), ...a.report.otherFindings].map((f, i) =>
                <div key={i}><p className="font-medium text-sn-ink">{f.label} · {f.severity}</p>
                  <ul className="list-disc pl-5">{f.evidence.map((text, j) => <li key={j}>{text}</li>)}</ul>
                </div>)}
              {a.report.answers.map((answer, i) => <div key={i}><p className="font-medium text-sn-ink">{answer.question}</p><p>{answer.answer}</p></div>)}
              <p>{a.report.coverage?.complete ? "The judge received the complete saved evidence projection." : "Evidence coverage is incomplete or was not recorded; see the full assessment."}</p>
            </> : null}
            <div className="flex gap-4">
              <a className="underline" href={url}>Full assessment JSON</a>
              {a.log ? <a className="underline" href={`${url}?format=inspect`}>Download assessment Inspect log</a> : null}
            </div>
          </div>
        </details>;
      })}
    </div>
  </section>;
}
