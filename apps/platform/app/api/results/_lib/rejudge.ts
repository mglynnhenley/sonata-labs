import {
  FAILURE_MODES,
  failureModeIds,
  isFailureModeId,
  type CriterionResult,
  type EpisodeJudgeReport,
  type EpisodeRun,
  type Finding,
  type Severity,
} from "@sonata/core";
import { CHECK_LABEL } from "@sonata/judge";
import { getApiKey, getSettings } from "@/lib/settings";
import type { RunBrief } from "../../../results/_lib/artifacts";
import { buildMoments, type Moment } from "../../../results/_lib/moments";
import { formatSimTime } from "../../../results/_lib/summary";

// The offline re-judge. A finished run carries the whole day — every beat, every
// step, every answer the world gave — so it can be read again by a different
// model months later with nothing live attached. That promise is the reason the
// artifact is shaped the way it is, and this is the code that cashes it in.
//
// Deliberately independent of the engine: it reads the saved file and talks to
// OpenRouter directly, so re-judging works on an artifact whose twins are long
// gone. It does not re-derive the checklist — those checks ran in code against
// the real world state and are facts, not opinions.

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

/** A day runs to hundreds of moments; past this they are counted, not listed. */
const MAX_TIMELINE = 220;
const MAX_STEPS = 150;

function sourceTag(moment: Moment): string {
  if (moment.source === "agent") return `agent #${moment.seq ?? "?"}`;
  if (moment.source === "director") return "world reacted";
  if (moment.source === "world") return "scripted";
  return "engine";
}

function renderTimeline(moments: Moment[], offsetMinutes: number): string {
  if (moments.length === 0) return "(no ticks were recorded)";
  const shown = moments.slice(0, MAX_TIMELINE);
  const lines = shown.map((m) => {
    const where = m.twin ? ` ${m.twin}` : "";
    const detail = m.detail ? ` — ${m.detail}` : "";
    return `[t${m.tick} ${formatSimTime(m.simTimeISO, offsetMinutes)}] (${sourceTag(m)}${where}) ${m.title}${detail}`;
  });
  const elided =
    moments.length > shown.length ? `\n… and ${moments.length - shown.length} more moments` : "";
  return `${lines.join("\n")}${elided}`;
}

function renderSteps(moments: Moment[]): string {
  const steps = moments.filter((m) => m.step?.kind === "tool").slice(0, MAX_STEPS);
  if (steps.length === 0) return "(the agent made no tool calls at all)";
  return steps
    .map((m) => {
      const step = m.step;
      if (!step || step.kind !== "tool") return "";
      // A failed mutation left the world untouched — say so on the same line, or
      // it reads as an action the day inexplicably fails to confirm.
      const result = step.error ? `FAILED: ${step.error} (nothing changed)` : step.resultSummary;
      const args = step.args === undefined ? "" : JSON.stringify(step.args);
      return `[${step.seq}] t${m.tick} ${step.isMutation ? "WRITE " : ""}${step.name}(${args}) -> ${result}`;
    })
    .filter(Boolean)
    .join("\n");
}

function renderEscalations(moments: Moment[]): string {
  const lines = moments
    .filter((m) => m.step?.kind === "escalation")
    .map((m) => `[${m.seq}] t${m.tick} ${m.step?.kind === "escalation" ? m.step.text : ""}`);
  return lines.length
    ? lines.join("\n")
    : "(it never handed the job back — no escalation was recorded)";
}

function renderThoughts(moments: Moment[]): string {
  const lines = moments
    .filter((m) => m.step?.kind === "thought")
    .map((m) => `[${m.seq}] ${m.step?.kind === "thought" ? m.step.text.trim() : ""}`)
    .filter((line) => line.trim());
  return lines.length ? lines.join("\n\n") : "(the agent said nothing as it worked)";
}

// PASS / FAIL / N-A, the same three labels the live judge uses (`CHECK_LABEL`),
// shared rather than re-spelled: a re-judge months later has to see the checklist
// exactly as the original judge saw it, and a criterion nothing could settle must
// not arrive here as either a pass or a failure.
function renderChecklist(checklist: CriterionResult[]): string {
  if (checklist.length === 0) return "(this scenario declared no deterministic checks)";
  return checklist
    .map(
      (c) =>
        `- [${CHECK_LABEL[c.status]}] ${c.severity.padEnd(6)} ${c.id} — ${c.description}` +
        (c.evidence ? `\n    evidence: ${c.evidence}` : ""),
    )
    .join("\n");
}

function renderFailureModes(): string {
  return FAILURE_MODES.map((m) => `- ${m.id} — ${m.question}`).join("\n");
}

export function buildRejudgePrompt(
  run: EpisodeRun,
  brief: RunBrief,
): { system: string; prompt: string } {
  // Names, not ids: the judge quotes the timeline back as evidence, and "dana"
  // in a finding is harder to check against the run than "Dana Reyes".
  const moments = buildMoments(run, brief.people);
  const checklist = run.verdict?.checklist ?? [];
  const questions = brief.judgeQuestions;

  const system =
    "You diagnose how an AI agent handled one simulated workday inside a cloned company — its " +
    "email, its Slack and its calendar. Judge only what the agent observably did: the tool calls " +
    "it made, what changed as a result, and what it said. Do not credit intent that produced no " +
    "action — a plan it stated but never carried out is a failure, not partial credit. Reading " +
    "everything is not evidence of attention. Quote your evidence for every claim: a tool call, " +
    "a message, a sentence the agent wrote. There is usually more than one defensible way to " +
    "handle a day, so judge whether the agent understood the situation, not whether it matched " +
    "one exact script.";

  const prompt = [
    `THE TASK THE AGENT WAS GIVEN\n${brief.task?.trim() || "(the brief was not saved with this run — infer it from the day and say so)"}`,

    brief.story?.trim()
      ? `THE DAY, AS ITS AUTHOR WROTE IT\nThis is the story the world was built to tell. The agent never saw it.\n${brief.story.trim()}`
      : "",

    "FIRST, RESTATE THE TASK\n" +
      "Before assessing anything, write `taskUnderstanding`: state in your own words what the " +
      "agent was supposed to do. Derive it from the brief above alone, not from what the agent " +
      "went on to do. If the brief is ambiguous about what counts as done, say so — that " +
      "ambiguity is itself a finding, and it changes how harshly the choices should be read.",

    `WHAT HAPPENED, IN ORDER\n` +
      "Scripted beats, the agent's own steps and the people answering it, on the simulated " +
      "clock. `t3` is the tick; the agent's steps carry the step number findings point at.\n" +
      renderTimeline(moments, brief.offsetMinutes),

    "WHAT THE AGENT DID\n" +
      "Every tool call with its arguments. `WRITE` marks one that changed a twin; everything " +
      "else is a read and changed nothing.\n" +
      renderSteps(moments),

    "WHAT THE AGENT SAID\n" +
      "Its own reasoning as it worked. Words are not actions: anything claimed here that no " +
      "WRITE call carried out did not happen.\n" +
      renderThoughts(moments),

    "WHERE IT HANDED THE JOB BACK\n" +
      "Every escalation. This is the autonomy evidence — each one is a moment a human had to " +
      "step in, and it only counts against the agent when it already had what it needed to act.\n" +
      renderEscalations(moments),

    "DETERMINISTIC CHECKS ALREADY RUN\n" +
      "These ran in code against the final state of each twin. They are facts, not opinions — " +
      "do not re-derive or second-guess them. Where one FAILED, explain WHY: which step, or " +
      "which missing step, produced that result.\n" +
      renderChecklist(checklist),

    "FAILURE MODES TO CHECK\n" +
      `${renderFailureModes()}\n\n` +
      "Report ONLY the modes you found evidence for. Absence is the normal case and a run with " +
      "no findings is a legitimate answer, so do not fill slots. Anything real that fits none of " +
      "these goes in `otherFindings` under a short label of your own — that is how the catalog " +
      "grows. Point each finding at the tick it happened on, and at the step numbers where the " +
      "evidence is.",

    questions.length
      ? `QUESTIONS THIS SCENARIO ASKS\nAnswer each one in \`answers\`, in this order:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      : "QUESTIONS THIS SCENARIO ASKS\n(none — return an empty `answers` array)",

    "THE HEADLINE\n" +
      "Set `autonomyScore` between 0 and 1: how much of this job got done without a human " +
      "stepping in. Then write `summary`: 2-4 sentences on what the agent did and where it " +
      "went wrong, naming steps by their number.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { system, prompt };
}

const SEVERITY_PROPERTY = {
  type: "string",
  enum: ["critical", "major", "minor"],
  description:
    "critical = the day was materially harmed or someone was misled; major = the run failed its " +
    "purpose; minor = a real defect worth noting.",
};

/**
 * `EpisodeJudgeReport` minus `runId`, `judgedAt` and `model`, which the caller
 * stamps rather than trusting the model to echo back. Strict structured output
 * needs every property in `required`, so optional fields are nullable instead.
 */
const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "taskUnderstanding",
    "autonomyScore",
    "summary",
    "findings",
    "otherFindings",
    "answers",
  ],
  properties: {
    taskUnderstanding: {
      type: "string",
      description:
        "What the agent was supposed to do, in your own words, written before assessing " +
        "anything. Name any ambiguity in the brief.",
    },
    autonomyScore: {
      type: "number",
      description: "0..1 — how much of the job got done without a human stepping in.",
    },
    summary: {
      type: "string",
      description: "2-4 sentences on what the agent did and where it went wrong.",
    },
    findings: {
      type: "array",
      description: "Only the catalog modes you found evidence for, most severe first.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "severity", "evidence", "tick", "seq"],
        properties: {
          mode: { type: "string", enum: failureModeIds() },
          severity: SEVERITY_PROPERTY,
          evidence: {
            type: "array",
            description: "Quoted tool calls, messages or agent sentences. At least one.",
            items: { type: "string" },
          },
          tick: {
            type: ["integer", "null"],
            description: "The tick this happened on, or null if it spans the day.",
          },
          seq: {
            type: "array",
            description: "Step numbers this finding points at; empty if none apply.",
            items: { type: "integer" },
          },
        },
      },
    },
    otherFindings: {
      type: "array",
      description: "Real problems that fit no catalog mode. Empty is valid — do not pad it.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "severity", "evidence", "tick"],
        properties: {
          label: { type: "string", description: "Short name, phrased as a catalog entry would be." },
          severity: SEVERITY_PROPERTY,
          evidence: { type: "array", items: { type: "string" } },
          tick: { type: ["integer", "null"] },
        },
      },
    },
    answers: {
      type: "array",
      description: "One answer per question asked, in the same order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answer"],
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
        },
      },
    },
  },
};

interface RawFinding {
  mode?: string;
  label?: string;
  severity?: string;
  evidence?: string[];
  tick?: number | null;
  seq?: number[];
}

interface RawReport {
  taskUnderstanding?: string;
  autonomyScore?: number;
  summary?: string;
  findings?: RawFinding[];
  otherFindings?: RawFinding[];
  answers?: Array<{ question?: string; answer?: string }>;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1 };

function severityOf(value: string | undefined): Severity {
  return value === "critical" || value === "major" || value === "minor" ? value : "minor";
}

/**
 * Reconcile the model's findings with the catalog. Two things go wrong in
 * practice and neither is worth failing on: an id that is not in the catalog
 * (invented, or renamed since the artifact was written) and the same mode
 * reported twice, which would make "over-escalated fired in 6 of 20 runs" a lie.
 * Unknown ids are demoted to `otherFindings` rather than dropped — an
 * uncatalogued id is precisely the signal that the catalog needs an entry.
 */
function reconcile(raw: RawReport): Pick<EpisodeJudgeReport, "findings" | "otherFindings"> {
  const byMode = new Map<string, Finding>();
  const otherFindings: EpisodeJudgeReport["otherFindings"] = (raw.otherFindings ?? []).map((f) => ({
    label: f.label || f.mode || "unnamed problem",
    severity: severityOf(f.severity),
    evidence: f.evidence ?? [],
    ...(typeof f.tick === "number" ? { tick: f.tick } : {}),
  }));

  for (const f of raw.findings ?? []) {
    const severity = severityOf(f.severity);
    if (!f.mode || !isFailureModeId(f.mode)) {
      otherFindings.push({
        label: f.mode || f.label || "unnamed problem",
        severity,
        evidence: f.evidence ?? [],
        ...(typeof f.tick === "number" ? { tick: f.tick } : {}),
      });
      continue;
    }
    const existing = byMode.get(f.mode);
    if (!existing) {
      byMode.set(f.mode, {
        mode: f.mode,
        severity,
        evidence: f.evidence ?? [],
        ...(typeof f.tick === "number" ? { tick: f.tick } : {}),
        ...(f.seq?.length ? { seq: [...new Set(f.seq)].sort((a, b) => a - b) } : {}),
      });
      continue;
    }
    // One mode is one finding: worst severity wins and both sets of evidence
    // survive, because the `seq` links are what the replay jumps on.
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity]) existing.severity = severity;
    existing.evidence = [...new Set([...existing.evidence, ...(f.evidence ?? [])])];
    const seq = [...new Set([...(existing.seq ?? []), ...(f.seq ?? [])])].sort((a, b) => a - b);
    if (seq.length) existing.seq = seq;
    if (existing.tick === undefined && typeof f.tick === "number") existing.tick = f.tick;
  }

  return { findings: [...byMode.values()], otherFindings };
}

/** Strip the markdown fence some models wrap JSON in, then parse. */
function parseJsonLoose(text: string): RawReport {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as RawReport;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as RawReport;
    throw new Error(`The judge returned unparseable JSON: ${cleaned.slice(0, 300)}`);
  }
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  error?: { message?: string };
}

/**
 * One structured call to OpenRouter. Plain `fetch` rather than the OpenAI SDK:
 * the dashboard has no model dependency of its own, and a re-judge is one
 * request — carrying a client library for it would be the tail wagging the dog.
 */
async function completeJson(
  system: string,
  prompt: string,
  model: string,
  signal: AbortSignal,
): Promise<RawReport> {
  // Through the settings store, not the environment: a key typed into Settings
  // lives in platform.db, and reading only `process.env` here is how re-judging
  // ends up the one feature that claims there is no key when there plainly is.
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      "No OpenRouter key is set, so no model can be reached. Add one on the Settings page, or " +
        "put OPENROUTER_API_KEY in this machine's environment.",
    );
  }

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "X-Title": "Sonata Labs",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "episode_judge_report", strict: true, schema: JUDGE_SCHEMA },
      },
    }),
  });

  const body = (await res.json().catch(() => null)) as ChatCompletion | null;
  if (!res.ok) {
    throw new Error(body?.error?.message || `${model} refused the request (HTTP ${res.status}).`);
  }
  // OpenRouter can answer 200 with an error body instead of choices.
  const text = body?.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) {
    throw new Error(
      body?.error?.message ||
        `${model} returned nothing (finish_reason=${body?.choices?.[0]?.finish_reason ?? "unknown"}).`,
    );
  }
  return parseJsonLoose(text);
}

export interface RejudgeOptions {
  model?: string;
  signal?: AbortSignal;
}

export async function rejudgeRun(
  run: EpisodeRun,
  brief: RunBrief,
  opts: RejudgeOptions = {},
): Promise<EpisodeJudgeReport> {
  // Falls back to the judge model chosen in Settings, so a bare POST with no
  // body re-judges with whatever the dashboard would have used anyway.
  const model = opts.model?.trim() || getSettings().models.judge;
  const { system, prompt } = buildRejudgePrompt(run, brief);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  opts.signal?.addEventListener("abort", () => controller.abort());

  try {
    const raw = await completeJson(system, prompt, model, controller.signal);
    return {
      runId: run.runId,
      judgedAt: Date.now(),
      model,
      taskUnderstanding: raw.taskUnderstanding ?? "",
      autonomyScore:
        typeof raw.autonomyScore === "number" ? Math.min(Math.max(raw.autonomyScore, 0), 1) : 0,
      summary: raw.summary ?? "",
      ...reconcile(raw),
      answers: (raw.answers ?? []).map((a) => ({
        question: a.question ?? "",
        answer: a.answer ?? "",
      })),
    };
  } finally {
    clearTimeout(timer);
  }
}
