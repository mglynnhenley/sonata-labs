"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { EpisodeRun, TwinName } from "@sonata/core";
import { Badge, buttonClasses, Chip, IconArrowRight, PageHeader } from "@sonata/ui";
import { scrollBehavior } from "../../_components/scrollBehavior";
import type { RunBrief } from "../_lib/artifacts";
import { headlineUsd, type CostReport } from "../_lib/cost";
import { buildMoments, findMomentIndex, replayStats } from "../_lib/moments";
import { badgeStatus, outcomeLabel, summarizeRun } from "../_lib/summary";
import { CostBreakdown } from "../_components/CostBreakdown";
import { DayReplay } from "../_components/DayReplay";
import { FailureModes } from "../_components/FailureModes";
import { JudgeUnderstanding } from "../_components/JudgeUnderstanding";
import { RejudgeButton } from "../_components/RejudgeButton";
import { SuccessChecklist } from "../_components/SuccessChecklist";
import { VerdictHeader, type Section } from "../_components/VerdictHeader";

// The run view. One page, six sections, in the order you would ask the
// questions: how did it do, what did the judge think the job was, which criteria
// passed, how did it fail, what actually happened, and what it cost.
//
// This component owns exactly one piece of state that matters — which moment of
// the day is selected — because every other section hands off to it. A score
// opens the criteria; a criterion opens its tick; a finding opens its step. The
// replay is where all those doors lead, so it cannot own its own selection.

const TWIN_ORDER: readonly TwinName[] = ["gmail", "slack", "calendar"];

export function RunDetail({
  run,
  brief,
  cost,
}: {
  run: EpisodeRun;
  brief: RunBrief;
  cost: CostReport;
}) {
  const summary = useMemo(() => summarizeRun(run), [run]);
  const moments = useMemo(() => buildMoments(run, brief.people), [run, brief.people]);
  const stats = useMemo(() => replayStats(moments), [moments]);

  const [selected, setSelected] = useState(0);
  const [focusToken, setFocusToken] = useState(0);

  const checklistRef = useRef<HTMLDivElement | null>(null);
  const failuresRef = useRef<HTMLDivElement | null>(null);
  const replayRef = useRef<HTMLDivElement | null>(null);
  const costRef = useRef<HTMLDivElement | null>(null);

  const twins = useMemo(() => {
    const used = new Set<TwinName>(Object.keys(run.snapshots) as TwinName[]);
    for (const moment of moments) if (moment.twin) used.add(moment.twin);
    return TWIN_ORDER.filter((twin) => used.has(twin));
  }, [run.snapshots, moments]);

  const openSection = useCallback((section: Section) => {
    const target = {
      checklist: checklistRef,
      failures: failuresRef,
      replay: replayRef,
      cost: costRef,
    }[section];
    target.current?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  }, []);

  /**
   * Park the replay on a moment. The scroll happens inside `DayReplay` — it moves
   * focus to the row too, so the arrows keep working from wherever you landed,
   * and one scroll is calmer than two racing each other.
   */
  const jump = useCallback(
    (target: { seq?: number[]; tick?: number }) => {
      const index = findMomentIndex(moments, target);
      if (index < 0) {
        // The judge can name a step this artifact does not contain. Show the
        // replay rather than silently doing nothing.
        replayRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
        return;
      }
      setSelected(index);
      setFocusToken((token) => token + 1);
    },
    [moments],
  );

  const jumpSeq = useCallback((seq: number) => jump({ seq: [seq] }), [jump]);

  /**
   * No judging a day that is still being written: the API refuses it, and a
   * button that always errors is worse than no button. Rendered once and reused,
   * because the header and the judge section offer the same action.
   */
  const settled = run.status !== "queued" && run.status !== "running";
  const rejudge = (variant: "primary" | "secondary") =>
    settled ? (
      <RejudgeButton
        variant={variant}
        runId={run.runId}
        {...(run.verdict?.judge?.model ? { currentModel: run.verdict.judge.model } : {})}
      />
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link href="/runs" className="hover:text-sn-ink">
            Runs
          </Link>
        }
        title={run.specTitle}
        subtitle={brief.story?.trim() || undefined}
        meta={
          <>
            <Badge status={badgeStatus(summary)} size="sm">
              {outcomeLabel(summary)}
            </Badge>
            <Chip size="sm" icon={false} className="font-mono">
              {run.model}
            </Chip>
            {twins.map((twin) => (
              <Chip key={twin} size="sm" service={twin} />
            ))}
          </>
        }
        actions={
          <>
            {/* The report is worth handing over once the day is scored; before
                that it is a page of dashes, so it waits with the rejudge action. */}
            {settled ? (
              <Link
                href={`/runs/${encodeURIComponent(run.runId)}/report`}
                className={buttonClasses("secondary", "md")}
              >
                Report
                <IconArrowRight size="sm" />
              </Link>
            ) : null}
            {rejudge("secondary")}
          </>
        }
      />

      <VerdictHeader
        summary={summary}
        stats={stats}
        costUsd={headlineUsd(cost)}
        judgeAutonomy={run.verdict?.judge?.autonomyScore ?? null}
        {...(run.error ? { error: run.error } : {})}
        onOpen={openSection}
      />

      <JudgeUnderstanding
        judge={run.verdict?.judge ?? null}
        brief={brief}
        rejudge={rejudge("primary")}
      />

      <div id="checklist" ref={checklistRef}>
        <SuccessChecklist
          checklist={run.verdict?.checklist ?? []}
          score={summary.score}
          onJump={jump}
        />
      </div>

      <div id="failures" ref={failuresRef}>
        <FailureModes judge={run.verdict?.judge ?? null} onJump={jump} />
      </div>

      <div id="replay" ref={replayRef}>
        <DayReplay
          moments={moments}
          selected={selected}
          onSelect={setSelected}
          onJumpSeq={jumpSeq}
          offsetMinutes={brief.offsetMinutes}
          people={brief.people}
          focusToken={focusToken}
        />
      </div>

      <div id="cost" ref={costRef}>
        <CostBreakdown cost={cost} />
      </div>

      <p className="flex items-center gap-1.5 text-[12px] text-sn-subtle">
        <Link
          href={`/api/results/${encodeURIComponent(run.runId)}`}
          className="inline-flex items-center gap-1 text-sn-primary-ink hover:underline"
        >
          The raw artifact
          <IconArrowRight size="xs" />
        </Link>
        — everything on this page is derived from that one file.
      </p>
    </div>
  );
}
