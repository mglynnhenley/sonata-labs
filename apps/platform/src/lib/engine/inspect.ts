import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentTrace, EpisodeRun, LlmCall } from "@sonata/core";
import { traceCost } from "@sonata/engine";
import { getApiKey, getSettings } from "../settings";
import { claimRun, createRun, finishRun, getRun, heartbeatRun, reconcileLiveRuns, reconcileRun, thisProcess, updateRunProgress } from "../db";
import { newId } from "../../../app/api/_lib/store";
import { readRun, readSpec, readTrace, runsDir, writeTrace } from "../../../app/results/_lib/artifacts";
import { finalizeSession, sessionLaunch, sessionStatus, startSession, sessionModelCalls } from "./session";
import { resolveScenario, specForRun } from "./scenarios";
import type { RunPoll, RunView, StartEpisodeInput } from "./episode";
import { judgeRun } from "./verdict";
import { inspectRuntime } from "./inspectRuntime";
export { inspectRuntime } from "./inspectRuntime";
import { runExecution } from "@sonata/core";
import { startModelGateway, type ModelGatewaySpend } from "./modelGateway";

interface Live {
  view: RunView;
  child: ChildProcess;
  cancelled: boolean;
  stopReason?: string;
  judging?: boolean;
  judgeController?: AbortController;
  done: Promise<EpisodeRun>;
}
const globalRuns = globalThis as unknown as { __sonataInspectRuns?: Map<string, Live> };
function registry() { return globalRuns.__sonataInspectRuns ??= new Map<string, Live>(); }
function claim() {
  return { owner: thisProcess(), runIds: new Set([...registry()].filter(([, r]) => r.view.endedAt === null).map(([id]) => id)) };
}
export function reconcileRuns(): string[] { return reconcileLiveRuns(claim()); }


export function startEpisode(input: StartEpisodeInput): RunView {
  const runtime = inspectRuntime();
  const settings = getSettings();
  const model = input.model?.trim() || settings.models.agent;
  const baseUrl = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  const apiKey = getApiKey() || (!baseUrl.includes("openrouter.ai") ? "local" : null);
  if (!apiKey) throw new Error("Add an OpenRouter key in Settings before starting an Inspect evaluation.");
  const episode = resolveScenario(input.episodeId);
  const spec = specForRun(episode.spec, input.ticks, input.termination);
  const runId = input.runId || newId("run");
  if (!/^[\w-]+$/.test(runId)) throw new Error("Invalid run identifier.");
  // Never overwrite evidence from an earlier attempt at a benchmark cell.
  if (getRun(runId) || existsSync(path.join(runsDir(), `${runId}.json`))) throw new Error(`Run ${runId} already exists; use a new run id.`);
  const compression = input.compression ?? 60;
  const logDir = path.resolve(runsDir(), "inspect", runId);
  mkdirSync(logDir, { recursive: true });
  const session = startSession({
    episodeId: episode.id, runId, model, agentLabel: `Inspect: ${model}`, compression,
    ticks: input.ticks, twins: input.twins, seedWorld: input.seedWorld,
    // Grade after Inspect has flushed its agent evidence, so the judge can
    // read the same saved handoff and complete trace as a later rejudge.
    director: input.director, judge: false,
    directorModel: input.directorModel, judgeModel: input.judgeModel,
    termination: input.termination, timing: input.timing,
  });
  createRun({ id: runId, episodeId: episode.id, episodeTitle: episode.title, worldName: episode.worldName,
    model, totalTicks: session.plannedTicks, status: "queued", startedAt: session.startedAt, owner: thisProcess() });
  const view: RunView = {
    runId, episodeId: episode.id, title: episode.title, model, status: "queued", tick: 0,
    plannedTicks: session.plannedTicks, twins: session.twins, simTimeISO: session.simTimeISO,
    lastEvent: null, startedAt: session.startedAt, endedAt: null, score: null, autonomy: null,
    cost: null, error: null, live: true,
  };
  const child = spawn(runtime.python, ["-m", "sonata_inspect.worker"], {
    cwd: runtime.root, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENROUTER_API_KEY: "", OPENROUTER_BASE_URL: "", PYTHONUNBUFFERED: "1" },
  });
  const entry = { view, child, cancelled: false } as Live;
  registry().set(runId, entry);
  let output = "";
  const collect = (data: Buffer) => { output = (output + data.toString()).slice(-12000); };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  child.stdin?.on("error", () => undefined); // an early worker failure is handled by exited
  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  const gateway = startModelGateway({ runId, model, apiKey, baseUrl, maxCostUsd: spec.termination.maxCostUsd,
    getOtherCost: () => {
      const calls = sessionModelCalls(runId);
      return { usd: calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0), unpriced: calls.filter(call => call.costUsd === undefined && !call.error).length };
    },
    // Let Inspect consume the last response before the usual progress guard stops it.
    onLimit: reason => { limitTimer = setTimeout(() => { if (registry().has(runId)) stop(entry, reason); }, 750); limitTimer.unref(); },
  });
  void Promise.all([sessionLaunch(session), gateway]).then(([launch, modelGateway]) => child.stdin?.end(JSON.stringify({
    platformUrl: input.platformUrl || process.env.SONATA_PLATFORM_URL || "http://localhost:3000",
    ownerPid: process.pid, repoRoot: runtime.root, logDir, model, episodeId: episode.id, launch,
    director: input.director !== false, judge: false,
    timeoutSeconds: Math.ceil(spec.termination.maxWallClockMs / 1000) + 300,
    maxCostUsd: spec.termination.maxCostUsd,
    modelGateway: { url: modelGateway.url, token: modelGateway.token },
  }))).catch(error => {
    output += `Workplace setup failed: ${String(error)}`;
    child.kill("SIGTERM");
  });
  const timer = setInterval(() => {
    sync(entry);
    heartbeatRun(runId);
    if (entry.cancelled) return;
    if (Date.now() - view.startedAt >= spec.termination.maxWallClockMs && ["queued", "running"].includes(sessionStatus(runId)?.session.status ?? "")) {
      stop(entry, "Declared wall-clock budget exhausted; this is a partial evaluation.");
    }
    if (spec.termination.maxCostUsd !== undefined) {
      let agent = { usd: 0, calls: 0, unpriced: 0 };
      try { agent = JSON.parse(readFileSync(path.join(logDir, "progress.json"), "utf8")); } catch { /* no call completed yet */ }
      const world = sessionModelCalls(runId);
      const unpriced = agent.unpriced + world.filter(c => c.costUsd === undefined && !c.error).length;
      const total = agent.usd + world.reduce((n, c) => n + (c.costUsd ?? 0), 0);
      if (unpriced) stop(entry, "A provider omitted its price, so the declared spend guard cannot be enforced. Partial evaluation retained.");
      else if (total >= spec.termination.maxCostUsd) stop(entry, "Declared agent and world spend budget exhausted; this is a partial evaluation.");
    }
  }, 500);
  entry.done = (async () => {
    let failure: string | undefined;
    try {
      const code = await exited;
      if (code !== 0 && !entry.cancelled) failure = "Inspect could not complete the evaluation. See the saved Inspect log and worker diagnostic.";
    } catch (err) {
      failure = `Inspect could not start: ${(err as Error).message}`;
    }
    try {
      if (failure || entry.cancelled) await finalizeSession(runId, {
        status: entry.cancelled ? "aborted" : "failed", reason: entry.stopReason || failure!,
      });
      const poll = sessionStatus(runId);
      if (poll?.session.live) await finalizeSession(runId, { status: "failed", reason: "Inspect exited before the workplace finished." });
      const modelGateway = await gateway.catch(() => null);
      if (modelGateway) {
        await modelGateway.stop();
        writeFileSync(path.join(logDir, "model-gateway.json"), JSON.stringify({ runId, model, spend: modelGateway.spend() }, null, 2));
      }
      if (limitTimer) clearTimeout(limitTimer);
      let run = finishInspect(runId, logDir, entry.stopReason || failure, entry.cancelled);
      let judgeError: string | undefined;
      if (input.judge !== false && runExecution(run).executed && !failure && !entry.cancelled) {
        entry.judging = true;
        entry.judgeController = new AbortController();
        entry.view.status = "judging";
        updateRunProgress(runId, { status: "judging" });
        try { await judgeRun(run, readSpec(runId) ?? spec, { model: input.judgeModel, signal: entry.judgeController.signal }); }
        catch (err) { judgeError = `The day finished, but the judge did not: ${(err as Error).message}`; }
        run = finishInspect(runId, logDir);
        if (judgeError) {
          const file = path.join(runsDir(), `${runId}.json`);
          const raw = JSON.parse(readFileSync(file, "utf8"));
          raw.error = judgeError;
          if (raw.session) raw.session.caveats = [
            ...raw.session.caveats.filter((c: string) => !c.startsWith("The narrative judge was disabled")), judgeError,
          ];
          writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
          run = raw;
        }
      }
      entry.view = { ...entry.view, status: run.status, endedAt: run.endedAt ?? Date.now(),
        tick: run.ticks.length, score: run.verdict?.score ?? null, autonomy: run.verdict?.autonomy ?? null,
        cost: readTrace(runId) ? traceCost(readTrace(runId)!) : null,
        error: judgeError ?? run.error ?? sessionStatus(runId)?.session.error ?? null };
      const verdict = run.verdict;
      finishRun({ id: runId, status: run.status, endedAt: entry.view.endedAt!,
        ...(verdict ? { score: verdict.score, autonomy: verdict.autonomy, outcome: verdict.outcome } : {}),
        ...(entry.view.cost ? { costUsd: entry.view.cost.usd } : {}),
        ...(entry.view.error ? { error: entry.view.error } : {}) });
      return run;
    } finally {
      clearInterval(timer);
      if (limitTimer) clearTimeout(limitTimer);
      const modelGateway = await gateway.catch(() => null);
      if (modelGateway) {
        writeFileSync(path.join(logDir, "model-gateway.json"), JSON.stringify({ runId, model, spend: modelGateway.spend() }, null, 2));
        await modelGateway.stop();
      }
      // Keep only the artifact/DB once the process closes; they are the record.
      registry().delete(runId);
      writeFileSync(path.join(logDir, "worker.log"), output.replaceAll(apiKey, "[redacted]"));
    }
  })();
  entry.done.catch((err) => {
    finishRun({ id: runId, status: "failed", endedAt: Date.now(), error: `Inspect evidence could not be saved: ${(err as Error).message}` });
  });
  return view;
}

function sync(entry: Live): void {
  if (entry.judging) return;
  const poll = sessionStatus(entry.view.runId);
  if (!poll) return;
  const s = poll.session;
  const terminal = ["done", "failed", "aborted"].includes(s.status);
  entry.view = { ...entry.view, status: terminal ? "judging" : s.status, tick: s.tick,
    simTimeISO: s.simTimeISO, lastEvent: s.lastEvent, error: s.error };
  updateRunProgress(entry.view.runId, { status: entry.view.status, tick: s.tick, simTime: s.simTimeISO,
    ...(s.lastEvent ? { lastEvent: s.lastEvent } : {}) });
  // Session's terminal writer clears row ownership; Inspect still owns export.
  claimRun(entry.view.runId, thisProcess(), Date.now());
}

export function finishInspect(runId: string, logDir: string, failure?: string, cancelled = false): EpisodeRun {
  const file = path.join(runsDir(), `${runId}.json`);
  const run = JSON.parse(readFileSync(file, "utf8"));
  let agent: { runId: string; log: string; status: string; error?: string; llmCalls: LlmCall[]; agentSummary?: string } | null = null;
  try { agent = JSON.parse(readFileSync(path.join(logDir, "agent.json"), "utf8")); } catch { /* disclosed below */ }
  if (agent && agent.runId !== runId) throw new Error("Inspect evidence names a different run.");
  const trace: AgentTrace = readTrace(runId) ?? { runId, llmCalls: [], toolCalls: [] };
  if (agent) {
    trace.llmCalls = [...trace.llmCalls.filter(c => c.role !== "agent"), ...agent.llmCalls]
      .sort((a, b) => a.startedAt - b.startedAt).map((c, i) => ({ ...c, seq: i + 1 }));
    if (agent.agentSummary) trace.agentSummary = agent.agentSummary;
    const error = writeTrace(runId, trace);
    if (error) throw new Error(error);
  }
  let gatewaySpend: ModelGatewaySpend | undefined;
  try {
    const ledger = JSON.parse(readFileSync(path.join(logDir, "model-gateway.json"), "utf8"));
    if (ledger.runId !== runId) throw new Error("Model gateway evidence names a different run.");
    gatewaySpend = ledger.spend;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const agentUsd = agent?.llmCalls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0) ?? 0;
  const captureGap = gatewaySpend && (gatewaySpend.calls > (agent?.llmCalls.length ?? 0) || gatewaySpend.usd > agentUsd + 0.00000001)
    ? "The model gateway recorded usage missing from Inspect evidence. Its separate spend ledger is retained; this evaluation is unmeasured." : undefined;
  const caveats: string[] = run.session?.caveats ?? [];
  run.inspect = { runner: "inspect", log: agent?.log ?? null,
    transcriptUrl: `/api/runs/${runId}/inspect`, sessionId: runId,
    status: agent?.status ?? "missing", agentCallsCaptured: agent?.llmCalls.length ?? 0,
    timingPolicy: run.timing?.policy ?? "compressed-wall-time", ...(gatewaySpend ? { modelGateway: gatewaySpend } : {}) };
  const missing = !agent ? "Inspect agent evidence could not be exported; inspect the worker diagnostic. This evaluation is unmeasured." : undefined;
  const error = (failure && agent?.error && !cancelled ? `${failure} ${agent.error}` : failure) || missing || captureGap || (agent?.status !== "success" && !cancelled ? agent?.error || "Inspect evaluation did not complete." : undefined);
  if (error || cancelled) {
    run.status = cancelled ? "aborted" : "failed";
    run.error = error || "Stopped by the user.";
    run.verdict = null;
  }
  if (agent) {
    const cost = traceCost(trace);
    if (run.verdict) run.verdict.cost = cost;
    if (run.session) run.session.caveats = caveats.filter(c =>
      !c.startsWith("Agent-side model usage") && !c.startsWith("The trace holds the harness's own model calls") &&
      !c.startsWith("The agent is external, so its reasoning") &&
      !c.startsWith("Tool arguments and reads are not captured") &&
      !(run.verdict?.judge && c.startsWith("The narrative judge was disabled")));
    const toolNote = "Inspect retains tool arguments and reads in its transcript. Sonata's business timeline is reconstructed from app mutations; checks requiring full tool arguments still have that observation limit.";
    if (run.session && !run.session.caveats.includes(toolNote)) run.session.caveats.push(toolNote);
    if (trace.llmCalls.some(c => c.costUsd === undefined)) run.session?.caveats.push("Some model calls have no provider price; the displayed cost is only the captured subtotal.");
  } else run.session?.caveats.push(missing!);
  if (captureGap && run.session && !run.session.caveats.includes(captureGap)) run.session.caveats.push(captureGap);
  if (gatewaySpend?.unpriced && run.session) {
    const note = "The model gateway could not price every upstream request; its spend ledger is a known subtotal.";
    if (!run.session.caveats.includes(note)) run.session.caveats.push(note);
  }
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  return run;
}

export function status(runId: string, sinceTick = 0): RunPoll | null {
  const entry = registry().get(runId);
  if (entry) {
    sync(entry);
    const poll = sessionStatus(runId, sinceTick);
    return { run: entry.view, ticks: poll?.ticks ?? [], nextSinceTick: poll?.nextSinceTick ?? 0 };
  }
  reconcileRun(runId, claim());
  const row = getRun(runId);
  if (!row) return null;
  const run = readRun(runId);
  const verdict = run?.verdict;
  const ticks = run?.ticks ?? [];
  return { run: {
    runId, episodeId: row.episodeId, title: row.episodeTitle, model: row.model, status: row.status,
    tick: ticks.length || row.tick, plannedTicks: row.totalTicks,
    twins: sessionStatus(runId)?.session.twins ?? [], simTimeISO: row.simTime ?? "", lastEvent: row.lastEvent,
    startedAt: row.startedAt, endedAt: row.endedAt, score: verdict?.score ?? null, autonomy: verdict?.autonomy ?? null,
    cost: readTrace(runId) ? traceCost(readTrace(runId)!) : verdict?.cost ?? null, error: row.error, live: false,
  }, ticks: ticks.filter(t => t.tick >= sinceTick), nextSinceTick: ticks.length };
}
export function whenDone(runId: string): Promise<EpisodeRun> | null { return registry().get(runId)?.done ?? null; }
export async function runEpisodeToCompletion(input: StartEpisodeInput): Promise<EpisodeRun> {
  const view = startEpisode(input);
  return whenDone(view.runId)!;
}
export function liveRuns(): RunView[] { return [...registry().values()].map(e => e.view); }
export function cancel(runId: string): RunView | null {
  const entry = registry().get(runId);
  if (!entry) return status(runId)?.run ?? null;
  stop(entry, "Stopped by the user.");
  return entry.view;
}

function stop(entry: Live, reason: string): void {
  if (entry.judging) {
    entry.judgeController?.abort();
    return;
  }
  if (!entry.cancelled) {
    entry.cancelled = true;
    entry.stopReason = reason;
    void finalizeSession(entry.view.runId, { status: "aborted", reason }).catch(() => undefined);
    entry.child.kill("SIGINT");
    const kill = setTimeout(() => entry.child.kill("SIGKILL"), 135000);
    entry.child.once("close", () => clearTimeout(kill));
    kill.unref();
  }
}
