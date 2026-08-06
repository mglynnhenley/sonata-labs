import { referenceTriageAgent, TRIAGE_BRIEF } from "./agents";
import {
  connectGmail,
  defaultRootUrl,
  defaultToken,
  injectFixture,
  obtainAccessToken,
  latestActionId,
  resetSandbox,
  sandboxIsUp,
} from "./client";
import { extractMailboxProfile } from "./context";
import { runPipeline } from "./generate/pipeline";
import { gradeRun } from "./grade";
import { projectTrace } from "./judge/project";
import { judge } from "./judge/run";
import { captureSnapshot, diffSnapshots } from "./judge/snapshot";
import type { JudgeReport } from "./judge/types";
import { buildProbeOutcome } from "./observe";
import { getScenario } from "./scenarios";
import { attributeActions, readCalls, withRole, withTrace, type RunTrace } from "./trace";
import type {
  EvalReport,
  GradeCtx,
  MailboxProfile,
  StressScenario,
  TriageAgent,
} from "./types";

// The data-agnostic entry point. Everything about the probe is derived from
// whatever mailbox is currently loaded, so this works on a real synced account
// or the synthetic seed without changes.

/**
 * The report, plus the failure-mode diagnosis when the inline judge ran. The
 * diagnosis sits alongside the report rather than inside it because a saved run can
 * be judged, re-judged, or judged with a different model long after the report was
 * written — `<runId>.judge.json` is its home, and this is the inline copy.
 */
export type EvalReportWithJudge = EvalReport & { judgeReport?: JudgeReport };

export interface RunEvalOptions {
  scenario: StressScenario | string;
  agent?: TriageAgent;
  rootUrl?: string;
  token?: string;
  /**
   * Per-role model overrides. `rank`/`comprehend`/`options`/`compose` are generator
   * stage names, so no mapping table can drift out of step with the pipeline;
   * `judge` covers both the rubric's yes/no verdict and the failure-mode judge.
   */
  models?: {
    profiler?: string;
    generator?: string;
    judge?: string;
    agent?: string;
    rank?: string;
    comprehend?: string;
    options?: string;
    compose?: string;
  };
  corpusSampleSize?: number;
  exemplarCount?: number;
  /** Thread the probe onto a real thread when one is available (default true). */
  preferRealAnchor?: boolean;
  /** Reset the working mailbox after the run (default true). */
  /** Reset to the pristine snapshot before the run (default true) — this is what isolates runs. */
  resetBefore?: boolean;
  /**
   * Reset again afterwards (default FALSE). Leaving it off is what makes a finished
   * run inspectable in the UI: the injected thread, the replies the agent sent, its
   * drafts and label changes all stay put until the next run resets them.
   */
  resetAfter?: boolean;
  useJudge?: boolean;
  /** Diagnose failure modes after grading (default true; needs `trace` to have anything to read). */
  judgeFailureModes?: boolean;
  /**
   * Precomputed mailbox profile, to skip the profiler model call. Safe to reuse
   * across scenarios in one batch: each run resets to the same pristine snapshot.
   * `EvalReport.profile` carries the one a run derived, so a batch can pass it on.
   */
  profile?: MailboxProfile;
  onProgress?: (step: string) => void;
  /**
   * Pass a trace to capture every model call and agent tool call. The caller keeps
   * the reference and persists it; omit it and capture is inert.
   */
  trace?: RunTrace;
}

export function runEval(opts: RunEvalOptions): Promise<EvalReportWithJudge> {
  return withTrace(opts.trace, () => runTracedEval(opts));
}

async function runTracedEval(opts: RunEvalOptions): Promise<EvalReportWithJudge> {
  const started = Date.now();
  const requested =
    typeof opts.scenario === "string" ? getScenario(opts.scenario) : opts.scenario;
  // Opting out of real anchors asks for the unanchored variant of the scenario, and
  // `preferAnchor` is where the generator reads that — saying it there beats
  // threading a second flag through six stages that already have the answer.
  const scenario =
    opts.preferRealAnchor === false ? { ...requested, preferAnchor: false } : requested;
  const rootUrl = opts.rootUrl ?? defaultRootUrl();
  const token = opts.token ?? defaultToken();
  const agent = opts.agent ?? referenceTriageAgent({ model: opts.models?.agent });
  const say = opts.onProgress ?? (() => {});

  if (!(await sandboxIsUp(rootUrl))) {
    throw new Error(
      `Sandbox is not responding at ${rootUrl}. Start it with \`PORT=${new URL(rootUrl).port || "3100"} npm start\`.`,
    );
  }

  // Reset BEFORE, not after. Isolation is identical either way, but resetting up
  // front also recovers from a previous run that crashed mid-flight, and it leaves
  // the finished mailbox intact so the UI can be inspected once the run ends.
  if (opts.resetBefore !== false) {
    say("resetting to pristine snapshot");
    await resetSandbox(`before eval: ${scenario.id}`, rootUrl);
  }

  // /gmail/v1/* is behind OAuth now: mint a provider access token with the admin
  // token, then connect the SDK the same way an agent would.
  const gmail = connectGmail(rootUrl, await obtainAccessToken(rootUrl, token));
  const userId = "me";

  // 1. Context — who this mailbox belongs to and who they talk to.
  // Reusable across scenarios: every run resets to the same pristine snapshot, so
  // the profile is identical each time and re-deriving it costs a model call per
  // scenario for no new information. `--all` computes it once and passes it down.
  let profile: MailboxProfile;
  if (opts.profile) {
    say("reusing mailbox profile");
    profile = opts.profile;
  } else {
    say("reading mailbox and building profile");
    profile = await withRole("profiler", () =>
      extractMailboxProfile(gmail, userId, {
        sampleSize: opts.corpusSampleSize,
        model: opts.models?.profiler,
      }),
    );
  }

  // 2. Generate — six stages: find the mailbox's usable history, pick the thread
  // this scenario can honestly be staged on, read it, date every slot against it,
  // choose an angle, write the prose. Each stage announces itself on `say`, so the
  // anchor it picked and any stage that degraded both surface as progress lines.
  say(`generating "${scenario.id}" fixture`);
  const {
    fixture,
    anchor,
    trace: generation,
  } = await runPipeline({
    gmail,
    userId,
    scenario,
    profile,
    options: {
      models: {
        rank: opts.models?.rank,
        comprehend: opts.models?.comprehend,
        options: opts.models?.options,
        // `generator` predates per-stage models and meant "the model that writes the
        // emails", which is now stage 6 — so it still means exactly that.
        compose: opts.models?.compose ?? opts.models?.generator,
      },
      exemplarCount: opts.exemplarCount,
      say,
    },
  });

  // 3. Inject.
  say(`injecting ${fixture.messages.length} message(s)`);
  const injected = await injectFixture(fixture.messages, rootUrl);
  // From here on the fixture is in the mailbox, so the reset has to run on the
  // way out even when the agent, the grader or the judge throws — otherwise the
  // next scenario would generate against this one's messages.
  try {
    const probe = injected.find((m) => m.slotId === fixture.probeSlotId);
    if (!probe) throw new Error("injection did not return the probe message");
    const prior = fixture.priorSlotId
      ? injected.find((m) => m.slotId === fixture.priorSlotId)
      : undefined;

    // Watermark the audit log so grading sees only the agent's own actions.
    const sinceId = await latestActionId(rootUrl);
    // The mailbox as the agent finds it. Paired with the capture below this is the
    // whole environment half of the judge's evidence, and it ships inside the run
    // artifact so a standalone re-judge needs nothing live.
    say("snapshotting mailbox before triage");
    const before = await captureSnapshot(gmail, userId);

    // 4. Triage — the agent under test.
    say(`running agent: ${agent.name}`);
    await agent.triage({ gmail, userId, brief: TRIAGE_BRIEF });

    // Immediately after, and before the reset below throws the evidence away.
    say("snapshotting mailbox after triage");
    const after = await captureSnapshot(gmail, userId);

    // 5. Observe + grade.
    say("observing outcome");
    const probeMsg = fixture.messages.find((m) => m.slotId === fixture.probeSlotId)!;
    const outcome = await buildProbeOutcome({
      gmail,
      userId,
      probe,
      prior,
      probeSenderEmail: (probeMsg.from.match(/<([^>]+)>/)?.[1] ?? probeMsg.from).trim(),
      sinceId,
      rootUrl,
    });

    // Link the agent's mutations back to the tool calls that made them.
    if (opts.trace) attributeActions(opts.trace, outcome.allActions);

    say("grading");
    const ctx: GradeCtx = { scenario, fixture, injected, probe, prior, anchor };
    const verdict = await withRole("judge", () =>
      gradeRun(outcome, ctx, {
        model: opts.models?.judge,
        useJudge: opts.useJudge,
        reads: opts.trace ? readCalls(opts.trace) : undefined,
      }),
    );

    // 6. Diagnose. Unlike the rubric's own judge this runs even when a `must`
    // assertion failed — the runs that broke the rules are the ones most worth a
    // diagnosis. It reads nothing live: the projected trace and the snapshot diff are
    // exactly what a standalone re-judge would load off disk.
    let judgeReport: JudgeReport | undefined;
    if (opts.judgeFailureModes !== false && opts.trace) {
      try {
        say("diagnosing failure modes");
        judgeReport = await judge(
          {
            runId: opts.trace.runId,
            task: {
              brief: TRIAGE_BRIEF,
              scenarioTitle: scenario.title,
              difficulty: scenario.difficulty,
            },
            trace: projectTrace(opts.trace),
            env: diffSnapshots(before, after),
            assertions: verdict.assertions,
          },
          { model: opts.models?.judge },
        );
      } catch (err) {
        // A second opinion on a run that has already completed and graded. Losing it
        // costs one report; throwing here would cost the run that produced it.
        say(`failure-mode judge failed (${(err as Error).message}) — continuing`);
      }
    }

    return {
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      family: scenario.family,
      agentName: agent.name,
      anchoredToRealThread: !!anchor,
      fixture,
      injected,
      outcome,
      verdict,
      durationMs: Date.now() - started,
      runId: opts.trace?.runId,
      snapshots: { before, after },
      generation,
      judgeReport,
      profile,
    };
  } finally {
    // Resetting afterwards is off by default: isolation comes from the reset BEFORE
    // the run, and wiping here destroys exactly what you want to look at — the
    // injected thread, the agent's replies and drafts, its label changes. The
    // mailbox is the evidence, so it survives the run that produced it.
    if (opts.resetAfter) {
      say("resetting sandbox to pristine snapshot");
      await resetSandbox(`after eval: ${scenario.id}`, rootUrl);
    }
  }
}
