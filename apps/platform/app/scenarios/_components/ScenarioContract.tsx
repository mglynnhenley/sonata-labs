import type { EpisodeSpec, TwinName } from "@sonata/core";
import { Card } from "@sonata/ui";
import { buildContract, type ContractSection } from "../_lib/contract";

// Server component: the contract is pure data off the spec, so there is nothing
// to hold in client state. It sits between the walkthrough and the Environment
// card so a reader meets the promises before the people and the schedule.

function Section({ index, section }: { index: number; section: ContractSection }) {
  return (
    <section>
      <h3 className="text-sn-base font-semibold text-sn-ink">{index}. {section.title}</h3>
      <div className="mt-2 grid gap-3">
        {section.groups.map((group, g) => (
          <div key={g}>
            {group.heading ? <p className="text-sn-sm font-medium text-sn-ink">{group.heading}</p> : null}
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sn-sm leading-relaxed text-sn-muted">
              {group.items.map((item, i) => <li key={i} className="whitespace-pre-line">{item}</li>)}
            </ul>
          </div>
        ))}
        {section.deliverables?.length ? (
          <ol className="divide-y divide-sn-line border-t border-sn-line">
            {section.deliverables.map((row) => (
              <li key={row.id} className="py-2 text-sn-sm">
                <p className="text-sn-ink">
                  <span className="font-medium">{row.id}</span>
                  <span className="text-sn-muted"> · {row.severity} · {row.surface} · {row.deadline}</span>
                </p>
                <p className="mt-1 text-sn-muted">{row.description}</p>
                <p className="mt-1 text-sn-xs text-sn-muted">Settled: {row.settledBy}.</p>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

export function ScenarioContract({ spec, twins }: { spec: EpisodeSpec; twins: TwinName[] }) {
  const contract = buildContract(spec, twins);
  return (
    <Card padding="lg">
      <p className="text-sn-sm text-sn-muted">The contract</p>
      <h2 className="mt-1 text-sn-lg font-semibold text-sn-ink">What is asked, what is measured, and what is not</h2>
      <p className="mt-2 max-w-[76ch] text-sn-sm leading-relaxed text-sn-muted">
        Derived from the scenario as authored and the engine's own settings. Where a point is not declared separately from the brief, it says so.
      </p>
      <div className="mt-5 grid gap-7">
        {contract.sections.map((section, i) => <Section key={section.title} index={i + 1} section={section} />)}
      </div>
    </Card>
  );
}
