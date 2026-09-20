"use client";

import { useState } from "react";
import type { CriterionResult, EpisodeJudgeReport, Severity } from "@sonata/core";
import { Card, IconAlert, cn } from "@sonata/ui";
import type { Moment } from "../_lib/moments";
import { buildDayMap, columnSeverity, hasDayShape, type DayColumn } from "../_lib/daymap";
import { formatSimTime } from "../_lib/summary";

// WHERE the day went wrong, as a place rather than a paragraph.
//
// One column per tick. Height is how many tool calls the agent made in it, and
// the fill answers the only question that matters about effort: did any of it
// land. Petrol means something changed on a surface in that tick; grey means the
// agent spent the tick reading. A run that looks busy and finished nothing is a
// wall of grey, and no sentence conveys that as fast.
//
// THE FORM IS EMPHASIS, NOT CATEGORY. There is one series here — work — and the
// grey is a de-emphasis colour, not a second thing being counted. Which is also
// why the palette validator's "chroma floor" complaint about it is the right
// answer to the wrong question: a de-emphasis grey is supposed to read as grey.
// The checks that do bind were run and pass — petrol against this grey is ΔE 21
// under deuteranopia and both clear 3:1 on white.
//
// FAILURE IS NEVER COLOUR ALONE. The rail under the axis carries a shape and a
// count, and every mark is in the table view below, because sage and terracotta
// are ΔE 3.5 apart under deuteranopia — a red dot and a green dot are the same
// dot to a good number of the people this product is for.

/** Bars shorter than this are unreadable; a tick with any work gets at least it. */
const MIN_BAR_PCT = 6;

const SEVERITY_RING: Record<Severity, string> = {
  critical: "bg-sn-failed-ink",
  major: "bg-sn-failed-ink/80",
  minor: "bg-sn-gold",
};

export function DayFailureMap({
  moments,
  judge,
  checklist,
  offsetMinutes,
  onJump,
}: {
  moments: Moment[];
  judge: EpisodeJudgeReport | null;
  checklist: readonly CriterionResult[];
  offsetMinutes: number;
  /** Park the replay on the tick a column stands for. */
  onJump: (target: { tick: number }) => void;
}) {
  const map = buildDayMap(moments, judge, checklist);
  const [hovered, setHovered] = useState<number | null>(null);

  // A single tick is a bar, not a chart, and a day with no ticks is not a day.
  if (!hasDayShape(map)) return null;

  const active = map.columns.find((c) => c.tick === hovered) ?? null;

  return (
    <Card padding="lg" radius="2xl" className="scroll-mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="text-sn-md font-medium text-sn-ink">Where the day went wrong</h2>
        <Legend />
      </div>
      <p className="mt-1 max-w-[76ch] text-sn-sm text-sn-muted">
        One column per tick, as tall as the work the agent did in it.{" "}
        {map.spentIdle > 0 ? (
          <>
            <span className="font-medium text-sn-ink">
              {map.spentIdle} of {map.columns.length} ticks changed nothing
            </span>{" "}
            — it read, and moved on.{" "}
          </>
        ) : null}
        Click a column to open that moment in the replay.
      </p>

      {/* The plot. `items-end` is the baseline: every bar grows up from it, which
          is what makes the heights comparable at a glance. */}
      <div className="mt-5">
        <div
          className="flex h-[148px] gap-[2px]"
          onMouseLeave={() => setHovered(null)}
          aria-label="Tool calls per tick, and where the day went wrong"
        >
          {map.columns.map((column) => (
            <Column
              key={column.tick}
              column={column}
              peak={map.peak}
              offsetMinutes={offsetMinutes}
              hovered={hovered === column.tick}
              dimmed={hovered !== null && hovered !== column.tick}
              onHover={() => setHovered(column.tick)}
              onJump={() => onJump({ tick: column.tick })}
            />
          ))}
        </div>

        {/* The baseline itself, and the clock under it. */}
        <div className="h-px w-full bg-sn-line-strong" />
        <div className="mt-1.5 flex justify-between text-sn-xs text-sn-subtle">
          <span className="font-mono">
            {formatSimTime(map.columns[0].simTimeISO, offsetMinutes)}
          </span>
          <span className="font-mono">
            {formatSimTime(map.columns[map.columns.length - 1].simTimeISO, offsetMinutes)}
          </span>
        </div>
      </div>

      {/* One fixed-height slot, so the chart does not jump as the pointer moves. */}
      <div className="mt-3 min-h-[68px]">
        {active ? (
          <Readout column={active} offsetMinutes={offsetMinutes} />
        ) : (
          <Summary map={map} />
        )}
      </div>

      <TableView columns={map.columns} offsetMinutes={offsetMinutes} />
    </Card>
  );
}

/**
 * One tick.
 *
 * A button, not a div: every column is a door into the replay, and a chart whose
 * marks can only be reached with a mouse is a chart half this product's readers
 * cannot use. The accessible name carries the numbers, so a screen reader gets
 * the same reading the tooltip gives everyone else.
 */
function Column({
  column,
  peak,
  offsetMinutes,
  hovered,
  dimmed,
  onHover,
  onJump,
}: {
  column: DayColumn;
  peak: number;
  offsetMinutes: number;
  hovered: boolean;
  dimmed: boolean;
  onHover: () => void;
  onJump: () => void;
}) {
  const severity = columnSeverity(column);
  const flagged = severity !== null;
  const landed = column.changes > 0;
  const height = column.calls === 0 ? 0 : Math.max(MIN_BAR_PCT, (column.calls / peak) * 100);

  return (
    <button
      type="button"
      onMouseEnter={onHover}
      onFocus={onHover}
      onClick={onJump}
      title={`Tick ${column.tick} · ${formatSimTime(column.simTimeISO, offsetMinutes)}`}
      aria-label={
        `Tick ${column.tick}, ${formatSimTime(column.simTimeISO, offsetMinutes)}. ` +
        `${column.calls} tool call${column.calls === 1 ? "" : "s"}, ` +
        `${column.changes} change${column.changes === 1 ? "" : "s"}.` +
        (flagged ? ` ${column.findings.map((f) => f.label).join(", ") || "Criterion failed"}.` : "")
      }
      className={cn(
        "group flex h-full min-w-[3px] flex-1 cursor-pointer flex-col rounded-t-[4px]",
        "transition-opacity duration-150 ease-sn focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sn-primary",
        dimmed && "opacity-45",
      )}
    >
      {/* A rail at a FIXED height, not the top of each column. Pinned to the bar
          the marks land wherever that bar happens to end, and eight of them
          scattered across eight heights is a puzzle rather than an answer to
          "where". At one height they read as a row: here, here, and here. */}
      <span className="flex h-3 shrink-0 items-start justify-center">
        {flagged ? (
          <span
            aria-hidden
            className={cn("h-[7px] w-[7px] rotate-45 rounded-[1px]", SEVERITY_RING[severity])}
          />
        ) : null}
      </span>

      {/* The plot area proper. `items-end` is the baseline every bar grows from. */}
      <span
        className={cn(
          "flex w-full flex-1 items-end rounded-t-[3px]",
          // A wash behind a flagged column, so the eye lands on the right part of
          // the day before it has read anything. Reinforcement only — the mark
          // above and the table below both carry this without colour.
          flagged && "bg-sn-failed-soft/70",
        )}
      >
        <span
          aria-hidden
          style={{ height: `${height}%` }}
          className={cn(
            "w-full rounded-t-[4px]",
            // Emphasis: the accent carries "something changed here", and
            // everything else recedes. Never the other way round.
            landed ? "bg-sn-primary" : "bg-sn-chart-idle",
            hovered && "brightness-110",
            // A tick with no calls still occupies its slot, or the day's shape
            // lies about how long it was.
            column.calls === 0 && "h-[2px] bg-sn-line-strong",
          )}
        />
      </span>
    </button>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sn-xs text-sn-muted">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] bg-sn-primary" />
        Something changed
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] bg-sn-chart-idle" />
        Only read
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-[7px] w-[7px] rotate-45 rounded-[1px] bg-sn-failed-ink" />
        Something went wrong
      </span>
    </div>
  );
}

/** What the whole day amounts to, shown until the reader points at a tick. */
function Summary({ map }: { map: ReturnType<typeof buildDayMap> }) {
  if (map.flagged.length === 0) {
    return (
      <p className="text-sn-sm text-sn-muted">
        Nothing is flagged on this day. {map.productive} of {map.columns.length} ticks changed
        something.
      </p>
    );
  }
  return (
    <div className="flex items-start gap-2.5 rounded-sn-lg border border-sn-failed-line bg-sn-failed-soft/40 px-3.5 py-2.5">
      <IconAlert size="sm" className="mt-0.5 shrink-0 text-sn-failed-ink" />
      <p className="max-w-[76ch] text-sn-sm leading-[19px] text-sn-muted">
        <span className="font-medium text-sn-failed-ink">
          {map.flagged.length} of {map.columns.length} ticks went wrong
        </span>{" "}
        — {map.flagged.length === 1 ? "tick" : "ticks"}{" "}
        <span className="font-mono">{map.flagged.join(", ")}</span>. Point at one for what
        happened in it, or click through to the replay.
      </p>
    </div>
  );
}

/** The pointed-at tick, in words. The tooltip, kept in the layout rather than floating over it. */
function Readout({ column, offsetMinutes }: { column: DayColumn; offsetMinutes: number }) {
  return (
    <div className="rounded-sn-lg border border-sn-line bg-sn-bg-subtle px-3.5 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="text-sn-sm font-medium text-sn-ink">
          Tick {column.tick} ·{" "}
          <span className="font-mono">{formatSimTime(column.simTimeISO, offsetMinutes)}</span>
        </span>
        <span className="text-sn-sm text-sn-muted">
          {column.calls} tool call{column.calls === 1 ? "" : "s"},{" "}
          {column.changes === 0 ? (
            <span className="text-sn-gold-ink">nothing changed</span>
          ) : (
            <>
              {column.changes} change{column.changes === 1 ? "" : "s"}
            </>
          )}
          {column.escalated ? " · handed back to a human" : ""}
        </span>
      </div>
      {column.findings.length > 0 || column.failed.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {column.findings.map((f, i) => (
            <li key={`f${i}`} className="text-sn-sm text-sn-failed-ink">
              {f.label} <span className="text-sn-subtle">({f.severity})</span>
            </li>
          ))}
          {column.failed.map((c, i) => (
            <li key={`c${i}`} className="text-sn-sm text-sn-failed-ink">
              Criterion failed: <span className="text-sn-muted">{c}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The same numbers as a table.
 *
 * Not a courtesy. The two fills clear contrast on white but the failure marks are
 * status colours, and status colours are never allowed to be the only way a fact
 * reaches a reader — so every mark above is also a row here, readable with no
 * colour vision at all and with a screen reader.
 */
function TableView({ columns, offsetMinutes }: { columns: DayColumn[]; offsetMinutes: number }) {
  return (
    <details className="group mt-4 border-t border-sn-line pt-3">
      <summary className="cursor-pointer list-none text-sn-sm text-sn-subtle hover:text-sn-muted">
        <span className="group-open:hidden">Read the day as a table</span>
        <span className="hidden group-open:inline">Hide the table</span>
      </summary>
      <div className="mt-2.5 overflow-x-auto">
        <table className="w-full border-collapse text-sn-sm">
          <thead>
            <tr className="text-left text-sn-xs tracking-[0.06em] text-sn-subtle uppercase">
              <th className="border-b border-sn-line py-1.5 pr-4 font-medium">Tick</th>
              <th className="border-b border-sn-line py-1.5 pr-4 font-medium">Time</th>
              <th className="border-b border-sn-line py-1.5 pr-4 font-medium">Tool calls</th>
              <th className="border-b border-sn-line py-1.5 pr-4 font-medium">Changes</th>
              <th className="border-b border-sn-line py-1.5 font-medium">What went wrong</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((c) => (
              <tr key={c.tick} className="border-b border-sn-line/60">
                <td className="py-1.5 pr-4 font-mono text-sn-muted">{c.tick}</td>
                <td className="py-1.5 pr-4 font-mono text-sn-muted">
                  {formatSimTime(c.simTimeISO, offsetMinutes)}
                </td>
                <td className="py-1.5 pr-4 text-sn-ink" data-numeric>
                  {c.calls}
                </td>
                <td className="py-1.5 pr-4 text-sn-ink" data-numeric>
                  {c.changes}
                </td>
                <td className="py-1.5 text-sn-muted">
                  {[...c.findings.map((f) => `${f.label} (${f.severity})`), ...c.failed].join(
                    "; ",
                  ) || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
