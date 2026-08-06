import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LlmCall } from "@sonata/core";
import { runsDir } from "../../../results/_lib/artifacts";

// WHAT HAPPENED THE LAST TIME SOMEONE TRIED TO JUDGE THIS DAY.
//
// A run judges itself the moment it ends, so "no diagnosis" is no longer the
// resting state of a finished run — it is an event, and an event has to leave a
// record. Without one the page can only tell you a report is absent, which is
// the same sentence for "the judge is reading it right now", "the judge answered
// and was cut off mid-sentence" and "nobody has ever asked". Those are three
// different things to a reader deciding whether to spend another dollar.
//
// The record is a file beside the run rather than a column on the row, for the
// reason the whole artifact is: `sonata judge <runId>` runs in a different
// process from the dashboard, and both have to be able to write and read this.
//
// It lives in a SUBDIRECTORY on purpose. `listRuns` treats every `*.json` in the
// runs dir as a run — a sibling `<runId>.judging.json` would render a second,
// empty row for every judged day.

/** A run id is a filename base and it arrives from a URL — never trust it. */
const SAFE_RUN_ID = /^[\w.-]+$/;

/**
 * Past this, a pass that never wrote an ending did not finish anywhere.
 *
 * Deliberately not the "is anything in this process driving it" test, which is
 * wrong across processes: the CLI judges from its own. This is a clock bound
 * instead, and it holds for every process, because every judge call in the
 * product is aborted by `TIMEOUT_MS` (4 minutes) whoever made it. Twice that,
 * plus a minute for the write, cannot still be in flight.
 */
const STALE_MS = 9 * 60_000;

export interface JudgeSpend {
  /** Null when the provider returned no price — never a misleading 0. */
  usd: number | null;
  promptTokens: number;
  completionTokens: number;
}

export type JudgeAttemptState = "judging" | "judged" | "failed";

export interface JudgeAttempt {
  runId: string;
  state: JudgeAttemptState;
  model: string;
  startedAt: number;
  endedAt: number | null;
  /** Why it could not be diagnosed. Plain language: it is shown verbatim. */
  reason: string | null;
  /** What the attempt cost, whether or not it produced a report. */
  spend: JudgeSpend | null;
  /** False when a person pressed the button — the run judged itself otherwise. */
  automatic: boolean;
}

/** What the page needs, with `none` for a day nothing has ever been asked about. */
export interface JudgeState {
  state: JudgeAttemptState | "none";
  model: string | null;
  /** When the state was reached: judged-at, failed-at, or started-at while live. */
  at: number | null;
  reason: string | null;
  spend: JudgeSpend | null;
  automatic: boolean;
}

/**
 * The two records reconciled into the one thing a reader wants to know.
 *
 * The report on disk is the fact and the attempt is the news, and they can
 * disagree in the one direction that matters: a day judged last week, re-read
 * today by a model that fell over, still HAS a diagnosis — it is just not the one
 * that was asked for. That comes back as `judged` with the failure attached,
 * because hiding a report the reader can see, or hiding the failed re-read they
 * paid for, are both lies of omission.
 */
export function judgeState(input: {
  /** The saved report, if the run has one. */
  judged: { model: string; judgedAt: number } | null;
  attempt: JudgeAttempt | null;
  /** Why there was nothing to judge, for a day the agent never worked. */
  nothingToRead: string | null;
}): JudgeState {
  const { attempt, judged } = input;

  if (attempt?.state === "judging") {
    return {
      state: "judging",
      model: attempt.model || null,
      at: attempt.startedAt,
      reason: null,
      spend: null,
      automatic: attempt.automatic,
    };
  }

  if (judged) {
    return {
      state: "judged",
      model: judged.model || attempt?.model || null,
      at: judged.judgedAt,
      // Only a LATER failure is worth reporting next to a report that exists.
      reason: attempt?.state === "failed" ? attempt.reason : null,
      spend: attempt?.state === "judged" ? attempt.spend : null,
      automatic: attempt?.automatic ?? true,
    };
  }

  if (attempt?.state === "failed") {
    return {
      state: "failed",
      model: attempt.model || null,
      at: attempt.endedAt ?? attempt.startedAt,
      reason: attempt.reason,
      spend: attempt.spend,
      automatic: attempt.automatic,
    };
  }

  return {
    state: "none",
    model: null,
    at: null,
    reason: input.nothingToRead,
    spend: null,
    automatic: false,
  };
}

function attemptDir(): string {
  return path.join(path.resolve(runsDir()), "judging");
}

function attemptFile(runId: string): string | null {
  if (!SAFE_RUN_ID.test(runId)) return null;
  const dir = attemptDir();
  const file = path.resolve(dir, `${runId}.json`);
  // Belt and braces: even an id that passes the pattern must land inside the dir.
  return file.startsWith(dir + path.sep) ? file : null;
}

function write(attempt: JudgeAttempt): void {
  const file = attemptFile(attempt.runId);
  if (!file) return;
  try {
    mkdirSync(attemptDir(), { recursive: true });
    writeFileSync(file, `${JSON.stringify(attempt, null, 2)}\n`, "utf8");
  } catch (err) {
    // Bookkeeping must never cost the run its diagnosis. A judge pass that
    // succeeded and could not write this file still wrote its report.
    console.warn(`[sonata] could not record the judge attempt for ${attempt.runId}:`, (err as Error).message);
  }
}

function read(runId: string): JudgeAttempt | null {
  const file = attemptFile(runId);
  if (!file || !existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<JudgeAttempt>;
    if (typeof raw.startedAt !== "number") return null;
    const state: JudgeAttemptState =
      raw.state === "judged" || raw.state === "failed" ? raw.state : "judging";
    return {
      runId,
      state,
      model: typeof raw.model === "string" ? raw.model : "",
      startedAt: raw.startedAt,
      endedAt: typeof raw.endedAt === "number" ? raw.endedAt : null,
      reason: typeof raw.reason === "string" && raw.reason.trim() ? raw.reason : null,
      spend: spendOf(raw.spend),
      automatic: raw.automatic !== false,
    };
  } catch {
    return null; // absent, half-written, or hand-edited
  }
}

function spendOf(raw: unknown): JudgeSpend | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Partial<JudgeSpend>;
  return {
    usd: typeof s.usd === "number" && Number.isFinite(s.usd) ? s.usd : null,
    promptTokens: typeof s.promptTokens === "number" ? s.promptTokens : 0,
    completionTokens: typeof s.completionTokens === "number" ? s.completionTokens : 0,
  };
}

/** Opened when the call goes out, so an interrupted pass still leaves a trace. */
export function beginJudgeAttempt(input: {
  runId: string;
  model: string;
  automatic: boolean;
}): JudgeAttempt {
  const attempt: JudgeAttempt = {
    runId: input.runId,
    state: "judging",
    model: input.model,
    startedAt: Date.now(),
    endedAt: null,
    reason: null,
    spend: null,
    automatic: input.automatic,
  };
  write(attempt);
  return attempt;
}

/** Closed either way. A failed pass is a result, and it was paid for. */
export function finishJudgeAttempt(
  attempt: JudgeAttempt,
  outcome: { state: "judged" | "failed"; reason?: string; spend: JudgeSpend | null },
): void {
  write({
    ...attempt,
    state: outcome.state,
    endedAt: Date.now(),
    reason: outcome.reason?.trim() || null,
    spend: outcome.spend,
  });
}

/**
 * The attempt, with a stalled one told apart from a live one.
 *
 * A record left open by a process that died would otherwise say "judging" for
 * ever — the exact shape of the frozen "Running" run this dashboard has been
 * unpicking. `STALE_MS` is the bound that makes the difference decidable from
 * the file alone, in any process.
 */
export function readJudgeAttempt(runId: string): JudgeAttempt | null {
  const attempt = read(runId);
  if (!attempt || attempt.state !== "judging") return attempt;
  if (Date.now() - attempt.startedAt < STALE_MS) return attempt;
  return {
    ...attempt,
    state: "failed",
    reason:
      "the judge was still reading this day when whatever was running it stopped, so no diagnosis " +
      "ever came back",
  };
}

/**
 * File the judge's model call on the run's trace.
 *
 * The trace is the ledger every cost figure in the product is summed from, and
 * the judge is now an automatic call the owner is paying for without asking for
 * it. Left off the ledger it would be a bill that arrives nowhere — so it goes in
 * beside the agent's and the director's calls, verbatim, and the per-role
 * breakdown on the run page picks it up with no special case.
 *
 * Only ever an APPEND to the sibling `<runId>.trace.json`, and silent when there
 * is none. A trace invented here would be one judge call and nothing else, and
 * `costBreakdown` would read that as the whole bill for the day. A run whose
 * calls are embedded in the artifact instead (a session) is left alone too — the
 * engine owns that file, and the cost section says the judge's spend separately
 * rather than racing it for a write.
 */
export function recordJudgeCall(runId: string, call: Omit<LlmCall, "seq" | "role">): void {
  if (!SAFE_RUN_ID.test(runId)) return;
  const dir = path.resolve(runsDir());
  const file = path.resolve(dir, `${runId}.trace.json`);
  if (!file.startsWith(dir + path.sep) || !existsSync(file)) return;

  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const calls = raw.llmCalls;
    if (!Array.isArray(calls)) return;
    const seq = calls.reduce<number>(
      (max, c) => Math.max(max, typeof (c as LlmCall)?.seq === "number" ? (c as LlmCall).seq : 0),
      0,
    );
    calls.push({ ...call, seq: seq + 1, role: "judge" } satisfies LlmCall);
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(`[sonata] could not add the judge call to the trace for ${runId}:`, (err as Error).message);
  }
}
