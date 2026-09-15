import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LlmCall } from "@sonata/core";
import type { CompleteJSON } from "@sonata/judge";
import { getApiKey } from "../settings";
import { recordJudgeCall, type JudgeSpend } from "../../../app/api/results/_lib/judgeAttempt";
import { assessmentDir, evidenceHash, writeAssessment, type Assessment } from "./assessments";
import { inspectRuntime } from "./inspectRuntime";

interface JudgeExport {
  runId: string;
  assessmentId: string;
  status: string;
  log: string;
  error?: string;
  report?: unknown;
  llmCalls: LlmCall[];
}

/** The judge's sole model transport. The prompt remains owned by @sonata/judge. */
export function inspectCompletion(assessment: Assessment, signal: AbortSignal,
  onSpend: (spend: JudgeSpend) => void): CompleteJSON {
  return async <T>(request: Parameters<CompleteJSON>[0]): Promise<T> => {
    if (signal.aborted) throw new Error("The assessment was stopped before it started.");
    const runtime = inspectRuntime();
    const baseUrl = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
    const apiKey = getApiKey() || (!baseUrl.includes("openrouter.ai") ? "local" : null);
    if (!apiKey) throw new Error("Add an OpenRouter key in Settings before judging this run.");
    const dir = assessmentDir(assessment.runId, assessment.id);
    assessment.provenance.numericScoreEligible = assessment.provenance.numericScoreEligible === true && request.coverage?.complete === true;
    assessment.provenance.coverage = request.coverage;
    assessment.provenance.promptSha256 = evidenceHash(request);
    writeAssessment(assessment);
    writeFileSync(path.join(dir, "input.json"), JSON.stringify({ request, provenance: assessment.provenance }, null, 2));
    const child = spawn(runtime.python, ["-m", "sonata_inspect.judging"], {
      cwd: runtime.root, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OPENROUTER_API_KEY: apiKey, OPENROUTER_BASE_URL: baseUrl },
    });
    let output = "";
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-64_000); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.stdin.on("error", () => { /* spawn/close reports failures below */ });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill("SIGINT");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 10_000);
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      child.stdin.end(JSON.stringify({ runId: assessment.runId, assessmentId: assessment.id,
        ownerPid: process.pid, logDir: dir, request, provenance: assessment.provenance }));
      const code = await exited;
      const file = path.join(dir, "result.json");
      const result = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as JudgeExport : null;
      if (result) {
        if (result.runId !== assessment.runId || result.assessmentId !== assessment.id) {
          throw new Error("Inspect returned evidence for a different assessment.");
        }
        assessment.log = path.basename(result.log);
        for (const call of result.llmCalls) recordJudgeCall(assessment.runId, call);
        if (result.llmCalls.length) onSpend({
          usd: result.llmCalls.every(c => c.costUsd !== undefined)
            ? result.llmCalls.reduce((n, c) => n + c.costUsd!, 0) : null,
          promptTokens: result.llmCalls.reduce((n, c) => n + (c.tokens?.prompt ?? 0), 0),
          completionTokens: result.llmCalls.reduce((n, c) => n + (c.tokens?.completion ?? 0), 0),
        });
      }
      if (signal.aborted) throw new Error("The judge was stopped; any captured calls remain in its assessment log.");
      if (code !== 0 || result?.status !== "success" || !result.report) {
        throw new Error("Inspect could not complete the assessment. The saved assessment log contains the provider or scoring error.");
      }
      return result.report as T;
    } finally {
      signal.removeEventListener("abort", stop);
      if (killTimer) clearTimeout(killTimer);
      writeFileSync(path.join(dir, "worker.log"), output.replaceAll(apiKey, "[redacted]"));
    }
  };
}
