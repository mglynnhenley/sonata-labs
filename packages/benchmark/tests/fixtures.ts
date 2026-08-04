import type { EpisodeJudgeReport, EpisodeRun, Finding, RunCost, Severity } from "@sonata/core";
import type { BenchmarkMatrix } from "../src/plan";

// Fixtures for the offline tests. Nothing here calls a model or touches a twin:
// every test in this package runs on a laptop with the wifi off.

export const MATRIX: BenchmarkMatrix = {
  id: "bench1",
  scenarioIds: ["sla-escalation", "quiet-monday"],
  models: ["anthropic/claude-haiku-4.5", "openai/gpt-5-mini"],
  seeds: [1, 2],
};

export function cost(over: Partial<RunCost> = {}): RunCost {
  return { usd: 0.1, promptTokens: 1000, completionTokens: 200, llmCalls: 4, ...over };
}

export function finding(mode: string, severity: Severity = "major"): Finding {
  return { mode, severity, evidence: [`saw ${mode}`] };
}

export function judgeReport(over: Partial<EpisodeJudgeReport> = {}): EpisodeJudgeReport {
  return {
    runId: "r1",
    judgedAt: 5000,
    model: "anthropic/claude-haiku-4.5",
    taskUnderstanding: "Clear the inbox and keep the client informed.",
    autonomyScore: 0.7,
    summary: "Handled most of it, asked about one refund.",
    findings: [],
    otherFindings: [],
    answers: [],
    ...over,
  };
}

export interface RunOver {
  runId?: string;
  specId?: string;
  model?: string;
  status?: EpisodeRun["status"];
  score?: number;
  autonomy?: number;
  outcome?: "pass" | "partial" | "fail";
  usd?: number;
  ticks?: number;
  modes?: string[];
  startedAt?: number;
  endedAt?: number | null;
  /** Set to drop the verdict entirely — a run that died before it was scored. */
  noVerdict?: boolean;
  error?: string;
}

/** A finished episode, trimmed to the fields the benchmark actually reads. */
export function episodeRun(over: RunOver = {}): EpisodeRun {
  const runId = over.runId ?? "r1";
  const startedAt = over.startedAt ?? 1000;
  const findings = (over.modes ?? []).map((m) => finding(m));

  return {
    runId,
    specId: over.specId ?? "sla-escalation",
    specTitle: "The SLA escalation",
    model: over.model ?? "anthropic/claude-haiku-4.5",
    status: over.status ?? "done",
    startedAt,
    endedAt: over.endedAt === undefined ? startedAt + 60_000 : over.endedAt,
    ticks: Array.from({ length: over.ticks ?? 3 }, (_, i) => ({
      tick: i,
      simTimeISO: `2026-03-02T0${9 + i}:00:00.000Z`,
      startedAt: startedAt + i * 100,
      endedAt: startedAt + i * 100 + 50,
      beatsFired: [],
      directorEvents: [],
      agentSteps: [],
      notes: [],
    })),
    snapshots: {},
    verdict: over.noVerdict
      ? null
      : {
          outcome: over.outcome ?? "pass",
          score: over.score ?? 0.8,
          autonomy: over.autonomy ?? 0.8,
          checklist: [],
          judge: judgeReport({ runId, findings }),
          cost: cost({ usd: over.usd ?? 0.1 }),
        },
    ...(over.error === undefined ? {} : { error: over.error }),
  };
}
