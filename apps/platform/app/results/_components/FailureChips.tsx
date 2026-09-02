"use client";

import Link from "next/link";
import { Chip, cn } from "@sonata/ui";
import type { FailureChip } from "../_lib/summary";

// Severity is carried by weight, not by a word: three tones, worst darkest, so a
// row of chips reads at a glance before any of them is read as language.
const SEVERITY_TONE: Record<FailureChip["severity"], string> = {
  critical: "border-sn-failed-line bg-sn-failed-soft text-sn-failed-ink",
  major: "border-sn-warning-soft bg-sn-warning-soft text-sn-warning-ink",
  minor: "border-sn-line bg-sn-bg-subtle text-sn-muted",
};

export function FailureChipList({
  failures,
  max,
  href,
  className,
}: {
  failures: FailureChip[];
  /** Extras collapse into a "+n" chip; the row must not wrap into a paragraph. */
  max?: number;
  /** Makes each chip a door. Omit for a static list. */
  href?: string;
  className?: string;
}) {
  if (failures.length === 0) {
    return <span className="text-sn-sm text-sn-subtle">none found</span>;
  }

  const shown = max ? failures.slice(0, max) : failures;
  const hidden = failures.length - shown.length;

  return (
    <span className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {shown.map((failure, i) => {
        const chip = (
          <Chip
            key={`${failure.mode}-${i}`}
            size="sm"
            icon={false}
            className={cn(
              SEVERITY_TONE[failure.severity],
              // Uncatalogued findings wear the dashed border the trace panel gave
              // them: the judge named this one itself, and that is worth seeing.
              failure.uncatalogued && "border-dashed",
            )}
            title={`${failure.severity}${failure.uncatalogued ? " · not in the catalog" : ""}`}
          >
            {failure.label}
          </Chip>
        );
        return href ? (
          <Link
            key={`${failure.mode}-${i}`}
            href={href}
            onClick={(event) => event.stopPropagation()}
            className="rounded-full"
          >
            {chip}
          </Link>
        ) : (
          chip
        );
      })}
      {hidden > 0 ? (
        <span className="text-sn-xs text-sn-subtle" title={failures.map((f) => f.label).join(", ")}>
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}
