"use client";

import { getFailureMode, type EpisodeJudgeReport, type Severity } from "@sonata/core";
import { Badge, Card, IconAlert, IconArrowRight, IconCheck } from "@sonata/ui";
import { SEVERITY_BADGE, SEVERITY_ORDER } from "../_lib/summary";
import { judgeSight, sliceSentence, type JudgeSight } from "./harness";

// What went wrong, and where. Every finding the judge returns points at a moment
// — a tick, or the exact steps — so a finding is never a verdict you have to take
// on trust: click it and the replay parks on the thing being described.
//
// And how much of the day these were formed on, at the top of the list rather
// than in a footnote. A findings list is read as an inventory of what went wrong;
// one drawn from a sample is an inventory of what went wrong in the sample, and
// the difference has to be met before the first row, not after the last.

interface Row {
  key: string;
  label: string;
  /** The catalog's own question, which reads as the definition of the mode. */
  question?: string;
  severity: Severity;
  evidence: string[];
  seq: number[];
  tick?: number;
  uncatalogued: boolean;
}

function rowsOf(judge: EpisodeJudgeReport): Row[] {
  const rows: Row[] = [
    ...judge.findings.map((finding, i) => {
      const mode = getFailureMode(finding.mode);
      return {
        key: `finding-${finding.mode}-${i}`,
        // An id off disk can predate a catalog rename; fall back to the raw id.
        label: mode?.label ?? finding.mode,
        ...(mode ? { question: mode.question } : {}),
        severity: finding.severity,
        evidence: finding.evidence ?? [],
        seq: finding.seq ?? [],
        ...(finding.tick !== undefined ? { tick: finding.tick } : {}),
        uncatalogued: false,
      };
    }),
    ...judge.otherFindings.map((finding, i) => ({
      key: `other-${i}`,
      label: finding.label,
      severity: finding.severity,
      evidence: finding.evidence ?? [],
      seq: [] as number[],
      ...(finding.tick !== undefined ? { tick: finding.tick } : {}),
      uncatalogued: true,
    })),
  ];
  return rows.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}

export function FailureModes({
  judge,
  onJump,
}: {
  judge: EpisodeJudgeReport | null;
  onJump: (target: { seq?: number[]; tick?: number }) => void;
}) {
  if (!judge) return null;
  const rows = rowsOf(judge);
  const sight = judgeSight(judge);

  return (
    <Card
      padding="none"
      radius="2xl"
      title="How it failed"
      subtitle={
        rows.length === 0
          ? "The judge returns only the modes it found evidence for. It found none."
          : `${rows.length} finding${rows.length === 1 ? "" : "s"}. Click one to jump to the moment it happened.`
      }
      className="scroll-mt-6"
    >
      {sight ? <PartialSightNote sight={sight} empty={rows.length === 0} /> : null}

      {rows.length === 0 ? (
        <div className="flex items-center gap-2.5 px-5 pb-5 text-[13px] text-sn-muted">
          <span className="grid h-6 w-6 place-items-center rounded-full border border-sn-passed-line bg-sn-passed-soft text-sn-passed-ink">
            <IconCheck size={13} />
          </span>
          Nothing in the catalog fired, and the judge added nothing of its own.
        </div>
      ) : (
        <ul className="border-t border-sn-line">
          {rows.map((row) => (
            <FindingRow key={row.key} row={row} onJump={onJump} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * How much of the day these findings were formed on, stated before them.
 *
 * Two things to say and they are not the same. A measured sample is a known
 * shortfall: we can name what was left out. An unrecorded one is worse — the
 * report predates the counting, so nobody can say what it read, and the one thing
 * that must not happen is a silent report being read as a complete one.
 */
function PartialSightNote({
  sight,
  empty,
}: {
  sight: JudgeSight;
  empty: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5 border-t border-sn-gold/30 bg-sn-gold-soft/35 px-5 py-3">
      <IconAlert size={14} className="mt-0.5 shrink-0 text-sn-gold-ink" />
      <p className="max-w-[78ch] text-[12.5px] leading-[19px] text-sn-muted">
        {sight.kind === "partial" ? (
          <>
            <span className="font-medium text-sn-gold-ink">
              Formed on {sight.portion} of this day.
            </span>{" "}
            The day was too large to put in front of the assessor whole, so it read{" "}
            {sliceSentence(sight.missing[0])}, sampled evenly across the day.{" "}
            {empty
              ? "Finding nothing is a claim about that sample, not about the run."
              : "Anything the agent did inside a gap is missing from this list."}{" "}
            Ours, not the agent&rsquo;s — the full account is at the top of the page.
          </>
        ) : (
          <>
            <span className="font-medium text-sn-gold-ink">
              How much of this day the assessor read was not recorded.
            </span>{" "}
            This report predates the counting, so we cannot tell you whether{" "}
            {empty ? "it found nothing in the whole run" : "this list was formed on the whole run"}{" "}
            or on part of it. Not recorded is not the same as complete — re-judge the run to find
            out.
          </>
        )}
      </p>
    </div>
  );
}

function FindingRow({
  row,
  onJump,
}: {
  row: Row;
  onJump: (target: { seq?: number[]; tick?: number }) => void;
}) {
  const canJump = row.seq.length > 0 || row.tick !== undefined;

  return (
    <li className="border-b border-sn-line/70 px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge status={SEVERITY_BADGE[row.severity]} size="sm">
          {row.severity}
        </Badge>
        <span className="text-[14px] font-medium text-sn-ink">{row.label}</span>
        {row.uncatalogued ? (
          <span
            className="rounded-full border border-dashed border-sn-line-strong px-1.5 py-0.5 text-[10.5px] text-sn-subtle"
            title="Not in the failure-mode catalog — the judge named this one itself"
          >
            uncatalogued
          </span>
        ) : null}
        {canJump ? (
          <button
            type="button"
            onClick={() => onJump({ seq: row.seq, ...(row.tick !== undefined ? { tick: row.tick } : {}) })}
            className="ml-auto inline-flex items-center gap-1.5 text-[12.5px] font-medium text-sn-primary-ink hover:underline"
          >
            {row.tick !== undefined ? `Go to tick ${row.tick}` : "Go to the moment"}
            <IconArrowRight size={13} />
          </button>
        ) : null}
      </div>

      {row.question ? (
        <p className="mt-1.5 text-[12.5px] leading-[19px] text-sn-subtle">{row.question}</p>
      ) : null}

      {row.evidence.length > 0 ? (
        <ul className="mt-2.5 space-y-1.5">
          {row.evidence.map((quote, i) => (
            <li
              key={i}
              className="border-l-2 border-sn-line-strong pl-3 text-[13px] leading-[20px] text-sn-muted"
            >
              {quote}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12.5px] text-sn-subtle">
          The judge quoted nothing for this one, which is itself worth a second look.
        </p>
      )}
    </li>
  );
}
