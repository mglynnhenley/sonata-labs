import { Card, Chip, cn } from "@sonata/ui";
import type { DayShape } from "../_lib/shape";

// The first thing on a report, and the only part written for someone who does
// not do the job.
//
// Everything below it speaks the scenario's language — CRS decisions, exception
// packets, accession numbers — and a reader without that vocabulary cannot tell
// a good day from a bad one, or tell either from a day we cut short. This band
// answers the three questions that do not need the domain: how far it got, how
// much it did, and whether any of it could be marked.
//
// It deliberately carries no score. A number here would be read as the verdict
// and skimmed instead of the checklist, which is the thing that actually knows.

const CAUSE: Record<DayShape["cause"], { label: string; tone: string } | null> = {
  // Said in the first person, matching the harness-faults card: the reader needs
  // to know this shape was ours before they read a list of things "it never did".
  harness: { label: "Our doing, not the agent's", tone: "border-sn-warning-line bg-sn-warning-soft text-sn-warning-ink" },
  agent: { label: "The agent's own day", tone: "border-sn-line bg-sn-bg-subtle text-sn-muted" },
  // Nothing printed rather than a guess: an artifact that cannot say whose doing
  // a shape was should not imply either answer.
  unknown: null,
};

export function DayShapeBand({ shape, attributed = false }: {
  shape: DayShape;
  /**
   * True when the harness-faults card is also on this page. It makes the same
   * point at length and in the first person, and two claims of "ours, not the
   * agent's" stacked on top of each other read as a page hedging.
   */
  attributed?: boolean;
}) {
  const cause = attributed ? null : CAUSE[shape.cause];
  return (
    <Card padding="lg" title="What kind of day this was">
      <p className="max-w-[78ch] text-sn-base text-sn-ink">{shape.headline}</p>

      <dl className="mt-5 grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        {shape.facts.map((fact) => (
          <div key={fact.label}>
            <dt className="text-sn-xs uppercase tracking-wide text-sn-subtle">{fact.label}</dt>
            <dd
              data-numeric
              className={cn(
                "mt-0.5 text-sn-base tabular-nums",
                fact.flag ? "font-medium text-sn-warning-ink" : "text-sn-ink",
              )}
            >
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>

      {cause ? (
        <div className="mt-5">
          <Chip size="sm" icon={false} className={cause.tone}>{cause.label}</Chip>
        </div>
      ) : null}

      <p className="mt-4 max-w-[78ch] text-sn-xs text-sn-subtle">
        Counted from the saved record, with no model involved. It describes the shape of the day,
        not the quality of the work — that is the checklist and the assessor below.
      </p>
    </Card>
  );
}
