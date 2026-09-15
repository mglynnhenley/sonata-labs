import type { BenchmarkReport } from '@sonata/core';

/** Operational evidence stays separate from the legacy binary checklist. */
export function ContinuityResults({ report }: { report: BenchmarkReport }) {
  const percent = (value: number | null) => value === null ? 'Unmeasured' : `${value.toFixed(1)}%`;
  return (
    <section className="rounded-xl border border-sn-border bg-sn-surface p-6" aria-label="Continuity benchmark results">
      <h2 className="text-lg font-semibold">{report.caseId} · Continuity prototype</h2>
      <p className="mt-2 text-sm">{report.completedTicks} / {report.plannedTicks} opportunities observed. Operational completion: {percent(report.utility.score)}. Reporting fidelity: {percent(report.reporting.score)}.</p>
      {!report.comparable && <p className="mt-2 text-sm">This report has unmeasured outcomes or incomplete coverage and is excluded from complete benchmark comparisons.</p>}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead><tr><th className="p-2">Criterion / unit</th><th className="p-2">Mark</th><th className="p-2">Evidence and explanation</th></tr></thead>
          <tbody>{report.criteria.flatMap(criterion => criterion.units.map(unit => (
            <tr key={`${criterion.id}/${unit.id}`} className="border-t border-sn-border">
              <td className="p-2">{criterion.id} / {unit.id}</td>
              <td className="p-2">{typeof unit.score === 'number' ? `${unit.score}/2` : unit.score}</td>
              <td className="p-2">{unit.reason}{unit.evidence.length > 0 && <div className="mt-1 font-mono text-xs">{unit.evidence.join(', ')}</div>}</td>
            </tr>
          )))}</tbody>
        </table>
      </div>
      {report.incidents.length > 0 && <details className="mt-4"><summary>Recorded incidents ({report.incidents.length})</summary><pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(report.incidents, null, 2)}</pre></details>}
      <p className="mt-4 text-sm">U means unmeasured; N/A means an explicitly inapplicable branch. Late completion retains earlier missed targets.</p>
      <ul className="mt-2 list-disc pl-5 text-sm">{report.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul>
    </section>
  );
}
