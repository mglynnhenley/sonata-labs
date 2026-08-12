"use client";

import { useState } from "react";
import { Card, IconChevronDown, cn } from "@sonata/ui";
import { ROLE_LABELS, headlineUsd, type CostReport, type RoleCost } from "../_lib/cost";
import { formatDuration, formatTokens, formatUsd, UNKNOWN } from "../_lib/summary";
import { useJudgeState } from "./judgeState";

// A cost figure opens onto the calls it is the sum of: role first, because
// "the judge cost more than the agent" is the finding that changes what you run
// next, then every call inside it with what it was asked and what it said.
//
// The judge's own call is in here now. It has to be: a run judges itself when it
// ends, so that call is spent on the owner's key without anyone pressing
// anything, and a bill that leaves out the one charge nobody asked for is the
// worst line to leave out. It also means the total here can exceed what the RUN
// recorded — the run's figure was closed before the judge read it — which is a
// difference the reader is told about rather than left to notice.

const ROLE_BAR: Record<string, string> = {
  agent: "bg-sn-primary",
  director: "bg-sn-gold",
  judge: "bg-sn-success",
  world: "bg-sn-info",
  generator: "bg-sn-neutral",
  profiler: "bg-sn-line-strong",
};

export function CostBreakdown({ cost }: { cost: CostReport }) {
  const total = headlineUsd(cost);
  // Shares are of what the calls account for, not of the headline: a partial
  // trace would otherwise draw every bar short of the width it has earned.
  const shareBase = cost.totalUsd ?? 0;
  const unpriced = cost.calls - cost.pricedCalls;
  const judge = cost.roles.find((role) => role.role === "judge");

  return (
    <Card
      padding="none"
      radius="2xl"
      title="What the day cost"
      subtitle={`${cost.calls} model call${cost.calls === 1 ? "" : "s"} · ${formatTokens(cost.promptTokens)} in, ${formatTokens(cost.completionTokens)} out`}
      className="scroll-mt-6"
    >
      <div className="flex items-baseline gap-3 px-5 pb-4">
        <span data-numeric className="font-display-upright text-[38px] leading-none text-sn-ink">
          {formatUsd(total)}
        </span>
        {unpriced > 0 && cost.hasPerCall ? (
          <span className="text-[12px] text-sn-subtle">
            {formatUsd(cost.totalUsd)} of it is priced per call — {unpriced} call
            {unpriced === 1 ? "" : "s"} came back without one
          </span>
        ) : cost.complete && cost.declaredUsd !== null &&
          Math.abs((cost.totalUsd ?? 0) - cost.declaredUsd) > 0.0005 ? (
          <span className="text-[12px] text-sn-subtle">
            {/* Almost always the judge: the run's own figure was closed at the end
                of the day, before anything read it back. Naming the difference is
                better than two numbers a page apart with no relation stated. */}
            {judge && judge.costUsd !== null
              ? `${formatUsd(cost.declaredUsd)} of it was the day itself; ${formatUsd(judge.costUsd)} was judging it`
              : `the run recorded ${formatUsd(cost.declaredUsd)}`}
          </span>
        ) : null}
      </div>

      {cost.roles.length === 0 ? (
        <p className="border-t border-sn-line px-5 py-4 text-[13px] text-sn-muted">
          No trace was saved beside this run, so the total above is all there is. Traces carry
          every model call verbatim — with one, this opens into per-call spend.
        </p>
      ) : (
        <ul className="border-t border-sn-line">
          {cost.roles.map((role) => (
            <RoleRow key={role.role} role={role} shareBase={shareBase} />
          ))}
        </ul>
      )}

      {judge ? null : <JudgeSpendNote />}
    </Card>
  );
}

/**
 * The judge's spend when the trace could not take it.
 *
 * A judge call is filed on the run's trace like any other, so the row above is
 * normally the whole story. A run with no trace beside it has nowhere to file it
 * — and since the pass is automatic, staying silent would hide a charge the owner
 * did not ask for. The attempt record kept the figure; this says it is not in the
 * total above rather than quietly adding it to a sum built from something else.
 */
function JudgeSpendNote() {
  const state = useJudgeState();
  const usd = state?.spend?.usd ?? null;
  if (usd === null) return null;

  return (
    <p className="border-t border-sn-line px-5 py-3 text-[12.5px] leading-[19px] text-sn-muted">
      Judging this day cost a further <span data-numeric>{formatUsd(usd)}</span>
      {state?.model ? (
        <>
          {" "}
          on <span className="font-mono text-[11.5px]">{state.model}</span>
        </>
      ) : null}
      . It is not in the figure above: that one is summed from the trace, and this run has no
      per-call trace to file the judge&rsquo;s own call on.
    </p>
  );
}

function RoleRow({ role, shareBase }: { role: RoleCost; shareBase: number }) {
  const [open, setOpen] = useState(false);
  const share = shareBase > 0 && role.costUsd !== null ? (role.costUsd / shareBase) * 100 : 0;

  return (
    <li className="border-b border-sn-line/70 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors duration-150 ease-sn hover:bg-sn-surface-hover"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="text-[13.5px] font-medium text-sn-ink">
              {ROLE_LABELS[role.role] ?? role.role}
            </span>
            <span className="text-[11.5px] text-sn-subtle">
              {role.calls} call{role.calls === 1 ? "" : "s"} · {formatDuration(role.ms)}
              {role.pricedCalls < role.calls
                ? ` · ${role.calls - role.pricedCalls} unpriced`
                : ""}
            </span>
          </span>
          <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-sn-bg-subtle">
            <span
              className={cn("block h-full rounded-full", ROLE_BAR[role.role] ?? "bg-sn-neutral")}
              style={{ width: `${Math.max(share, share > 0 ? 2 : 0)}%` }}
            />
          </span>
          <span className="mt-1 block truncate font-mono text-[11px] text-sn-subtle">
            {role.models.join(", ")}
          </span>
        </span>

        <span data-numeric className="shrink-0 text-[13.5px] font-medium text-sn-ink">
          {formatUsd(role.costUsd)}
        </span>
        <IconChevronDown
          size="md"
          className={cn(
            "shrink-0 text-sn-subtle transition-transform duration-150 ease-sn",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div className="animate-sn-slide-in sn-scroll max-h-[420px] overflow-y-auto border-t border-sn-line bg-sn-bg-subtle/50 px-5 py-3">
          <ul className="space-y-2.5">
            {role.lines.map((line) => (
              <li
                key={line.seq}
                className="rounded-sn-lg border border-sn-line bg-sn-surface p-3 text-[12.5px]"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span data-numeric className="font-mono text-[11px] text-sn-subtle">
                    #{line.seq}
                    {line.tick !== null ? ` · tick ${line.tick}` : ""}
                  </span>
                  <span className="truncate font-mono text-[11px] text-sn-muted">{line.model}</span>
                  <span className="ml-auto flex items-center gap-2 text-[11px] text-sn-subtle">
                    <span data-numeric>
                      {formatTokens(line.promptTokens)} → {formatTokens(line.completionTokens)}
                    </span>
                    <span data-numeric>{formatDuration(line.ms)}</span>
                    <span data-numeric className="font-medium text-sn-ink">
                      {line.costUsd === null ? UNKNOWN : formatUsd(line.costUsd)}
                    </span>
                  </span>
                </div>
                {line.error ? (
                  <p className="mt-1.5 text-[12px] text-sn-failed-ink">{line.error}</p>
                ) : null}
                {line.ask ? (
                  <p className="mt-1.5 text-sn-muted">
                    <span className="text-sn-subtle">asked</span> {line.ask}
                  </p>
                ) : null}
                {line.said ? (
                  <p className="mt-1 text-sn-ink">
                    <span className="text-sn-subtle">said</span> {line.said}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
