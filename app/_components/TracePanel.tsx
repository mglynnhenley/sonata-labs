"use client";

import { useCallback, useEffect, useState } from "react";
import type { RunSummary } from "@/lib/eval/runs";
import type { LlmCall, RunTrace, ToolCall } from "@/lib/eval/trace";

// Replay of a finished eval run: every model call and every tool call, in the
// order they happened.
//
// Unlike ActivityPanel this component fetches its own data. Trace artifacts are
// immutable once written, so they don't belong in GmailApp's 3s poll — keeping
// them here avoids adding live-looking state for something that never changes.

type Step = ({ kind: "llm" } & LlmCall) | ({ kind: "tool" } & ToolCall);

/** Minimal view of an OpenAI-shaped completion — enough to summarise a turn. */
interface ChatResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string } }> };
  }>;
  usage?: { total_tokens?: number };
}

const ROLE_STYLE: Record<string, string> = {
  profiler: "bg-[#e8f0fe] text-[#1967d2]",
  generator: "bg-[#fce8e6] text-[#c5221f]",
  judge: "bg-[#e6f4ea] text-[#137333]",
  agent: "bg-[#f3e8fd] text-[#7b1fa2]",
};

function stepsOf(trace: RunTrace): Step[] {
  return [
    ...trace.llmCalls.map((c) => ({ kind: "llm" as const, ...c })),
    ...trace.toolCalls.map((c) => ({ kind: "tool" as const, ...c })),
  ].sort((a, b) => a.seq - b.seq);
}

function assistantTurn(call: LlmCall): { text: string; toolNames: string[]; tokens?: number } {
  const res = call.response as ChatResponse | undefined;
  const message = res?.choices?.[0]?.message;
  const toolNames = (message?.tool_calls ?? [])
    .map((t) => t.function?.name)
    .filter((n): n is string => !!n);
  return { text: message?.content?.trim() ?? "", toolNames, tokens: res?.usage?.total_tokens };
}

/** The harness's own stages are single structured completions, not conversation. */
const STAGE_LABEL: Record<string, string> = {
  profiler: "read the mailbox",
  generator: "wrote the fixture",
  judge: "judged the run",
};

function stepLabel(step: Step): string {
  if (step.kind === "tool") return step.name;
  if (step.role !== "agent") return STAGE_LABEL[step.role] ?? step.role;
  const { text, toolNames } = assistantTurn(step);
  if (toolNames.length) return `thinking → ${toolNames.join(", ")}`;
  return text ? "final message" : "(empty turn)";
}

export function TracePanel({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState<string>("");
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/eval/runs")
      .then((r) => r.json())
      .then((d: { runs?: RunSummary[] }) => {
        const withTrace = (d.runs ?? []).filter((r) => r.hasTrace);
        setRuns(withTrace);
        if (withTrace.length) setRunId(withTrace[0].runId);
      })
      .catch(() => setError("could not load runs"));
  }, []);

  useEffect(() => {
    if (!runId) return;
    setTrace(null);
    setSelected(0);
    fetch(`/api/eval/runs/${runId}/trace`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("not found"))))
      .then(setTrace)
      .catch(() => setError("could not load trace"));
  }, [runId]);

  const steps = trace ? stepsOf(trace) : [];

  // Selecting a step jumps the mailbox to whatever it touched. Read-only: opening
  // a thread the normal way marks it read, which would write to the audit log the
  // Activity panel is showing.
  const select = useCallback(
    (index: number) => {
      setSelected(index);
      const step = steps[index];
      if (step?.kind === "tool" && step.threadId) onOpenThread(step.threadId);
    },
    [steps, onOpenThread],
  );

  const move = useCallback(
    (delta: number) => {
      if (!steps.length) return;
      select(Math.min(Math.max(selected + delta, 0), steps.length - 1));
    },
    [steps.length, selected, select],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return;
      if (e.key === "ArrowDown" || e.key === "j") move(1);
      else if (e.key === "ArrowUp" || e.key === "k") move(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  const run = runs.find((r) => r.runId === runId);

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-[#e0e3e7] bg-white">
      <div className="flex items-center gap-2 border-b border-[#e0e3e7] px-4 py-3">
        <span className="material-symbols-outlined text-[20px] text-[#5f6368]">route</span>
        <span className="text-sm font-medium text-[#202124]">Agent trace</span>
        {steps.length > 0 && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-[#5f6368]">
            <button
              onClick={() => move(-1)}
              className="rounded px-1 hover:bg-[#f1f3f4]"
              aria-label="Previous step"
            >
              <span className="material-symbols-outlined text-[16px]">keyboard_arrow_up</span>
            </button>
            {selected + 1}/{steps.length}
            <button
              onClick={() => move(1)}
              className="rounded px-1 hover:bg-[#f1f3f4]"
              aria-label="Next step"
            >
              <span className="material-symbols-outlined text-[16px]">keyboard_arrow_down</span>
            </button>
          </span>
        )}
      </div>

      <div className="border-b border-[#e0e3e7] px-4 py-2">
        <select
          value={runId}
          onChange={(e) => setRunId(e.target.value)}
          className="w-full rounded border border-[#dadce0] bg-white px-2 py-1 text-[12px] text-[#202124]"
        >
          {runs.length === 0 && <option value="">no traced runs yet</option>}
          {runs.map((r) => (
            <option key={r.runId} value={r.runId}>
              {r.scenarioId} · {r.outcome} · {r.runId.slice(0, 19)}
            </option>
          ))}
        </select>
        {run && (
          <div className="mt-1 truncate text-[11px] text-[#5f6368]" title={run.agentName}>
            {run.agentName}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto gm-scroll">
        {error && <div className="px-4 py-3 text-[12px] text-[#c5221f]">{error}</div>}
        {!error && runs.length === 0 && (
          <div className="px-4 py-3 text-[12px] text-[#5f6368]">
            No traces yet. Run <code className="text-[#202124]">npm run eval</code> to record one.
          </div>
        )}
        {!error && runId && !trace && (
          <div className="px-4 py-3 text-[12px] text-[#5f6368]">Loading…</div>
        )}
        {trace && steps.length === 0 && (
          <div className="px-4 py-3 text-[12px] text-[#5f6368]">
            This run made no model calls — the control agent takes no trace.
          </div>
        )}
        {steps.map((step, i) => (
          <StepItem key={step.seq} step={step} active={i === selected} onSelect={() => select(i)} />
        ))}
      </div>

      {trace?.agentSummary && (
        <div className="max-h-40 overflow-y-auto gm-scroll border-t border-[#e0e3e7] bg-[#f6f8fc] px-4 py-2 text-[11px] text-[#3c4043]">
          <div className="mb-1 font-medium text-[#202124]">The agent&apos;s own summary</div>
          {trace.agentSummary}
        </div>
      )}
    </aside>
  );
}

function StepItem({
  step,
  active,
  onSelect,
}: {
  step: Step;
  active: boolean;
  onSelect: () => void;
}) {
  const isTool = step.kind === "tool";
  const icon = isTool ? (step.isMutation ? "edit_note" : "visibility") : "smart_toy";
  const badge = isTool ? (step.isMutation ? "write" : "read") : step.role;

  return (
    <div
      className={`border-b border-[#f1f3f4] px-4 py-2.5 ${active ? "bg-[#e8f0fe]" : "hover:bg-[#f6f8fc]"}`}
    >
      <button onClick={onSelect} className="flex w-full items-start gap-2 text-left">
        <span className="material-symbols-outlined mt-0.5 text-[18px] text-[#5f6368]">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] text-[#202124]">{stepLabel(step)}</span>
            <span
              className={`ml-auto shrink-0 rounded px-1 text-[10px] font-medium ${
                isTool ? "bg-[#f1f3f4] text-[#5f6368]" : ROLE_STYLE[step.role]
              }`}
            >
              {badge}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-[#5f6368]">
            {step.endedAt - step.startedAt}ms
            {isTool && step.actionIds.length > 0 && ` · ${step.actionIds.length} logged`}
            {!isTool && assistantTurn(step).tokens !== undefined &&
              ` · ${assistantTurn(step).tokens} tok`}
          </div>
        </div>
      </button>
      {active && <StepDetail step={step} />}
    </div>
  );
}

function StepDetail({ step }: { step: Step }) {
  if (step.kind === "tool") {
    return (
      <div className="mt-2 space-y-1">
        <Pre label="args" value={step.args} />
        <Pre label="result" value={step.result} />
      </div>
    );
  }
  const { text } = assistantTurn(step);
  return (
    <div className="mt-2 space-y-1">
      {text && (
        <div className="whitespace-pre-wrap rounded bg-[#f6f8fc] p-2 text-[11px] text-[#3c4043]">
          {text}
        </div>
      )}
      <Pre label="response" value={step.response} />
    </div>
  );
}

function Pre({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-[#1a73e8] hover:underline"
      >
        {open ? "Hide" : "Show"} {label}
      </button>
      {open && (
        <pre className="mt-1 max-h-56 overflow-auto rounded bg-[#f6f8fc] p-2 text-[10px] text-[#3c4043] gm-scroll">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}
