import { referenceTriageAgent, TRIAGE_BRIEF } from "./agents";
import {
  connectGmail,
  defaultRootUrl,
  defaultToken,
  injectFixture,
  latestActionId,
  resetSandbox,
  sandboxIsUp,
} from "./client";
import { extractMailboxProfile, findAnchorThread, pickStyleExemplars } from "./context";
import { generateFixture, bindContact } from "./generate";
import { gradeRun } from "./grade";
import { buildProbeOutcome } from "./observe";
import { getScenario } from "./scenarios";
import type { Anchor, EvalReport, GradeCtx, StressScenario, TriageAgent } from "./types";

// The data-agnostic entry point. Everything about the probe is derived from
// whatever mailbox is currently loaded, so this works on a real synced account
// or the synthetic seed without changes.

export interface RunEvalOptions {
  scenario: StressScenario | string;
  agent?: TriageAgent;
  rootUrl?: string;
  token?: string;
  models?: { profiler?: string; generator?: string; judge?: string; agent?: string };
  corpusSampleSize?: number;
  exemplarCount?: number;
  /** Thread the probe onto a real thread when one is available (default true). */
  preferRealAnchor?: boolean;
  /** Reset the working mailbox after the run (default true). */
  resetAfter?: boolean;
  useJudge?: boolean;
  onProgress?: (step: string) => void;
}

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const started = Date.now();
  const scenario =
    typeof opts.scenario === "string" ? getScenario(opts.scenario) : opts.scenario;
  const rootUrl = opts.rootUrl ?? defaultRootUrl();
  const token = opts.token ?? defaultToken();
  const agent = opts.agent ?? referenceTriageAgent({ model: opts.models?.agent });
  const say = opts.onProgress ?? (() => {});

  if (!(await sandboxIsUp(rootUrl))) {
    throw new Error(
      `Sandbox is not responding at ${rootUrl}. Start it with \`PORT=${new URL(rootUrl).port || "3100"} npm start\`.`,
    );
  }

  const gmail = connectGmail(rootUrl, token);
  const userId = "me";

  // 1. Context — who this mailbox belongs to and who they talk to.
  say("reading mailbox and building profile");
  const profile = await extractMailboxProfile(gmail, userId, {
    sampleSize: opts.corpusSampleSize,
    model: opts.models?.profiler,
  });

  // 2. Anchor — a real thread to continue, so the agent works with real history.
  let anchor: Anchor | null = null;
  if (scenario.preferAnchor && opts.preferRealAnchor !== false) {
    anchor = await findAnchorThread(gmail, userId);
    if (anchor) say(`anchoring to real thread "${anchor.subject}" from ${anchor.fromName}`);
  }

  // 3. Generate — few-shot, in the mailbox's own voice.
  const contact = bindContact(scenario, profile, anchor);
  const exemplars = await pickStyleExemplars(gmail, userId, {
    fromEmail: contact.email,
    count: opts.exemplarCount ?? 3,
  });
  say(`generating "${scenario.id}" fixture as ${contact.name} <${contact.email}>`);
  const { fixture } = await generateFixture({
    scenario,
    profile,
    anchor,
    exemplars,
    options: { model: opts.models?.generator },
  });

  // 4. Inject.
  say(`injecting ${fixture.messages.length} message(s)`);
  const injected = await injectFixture(fixture.messages, rootUrl);
  const probe = injected.find((m) => m.slotId === fixture.probeSlotId);
  if (!probe) throw new Error("injection did not return the probe message");
  const prior = fixture.priorSlotId
    ? injected.find((m) => m.slotId === fixture.priorSlotId)
    : undefined;

  // Watermark the audit log so grading sees only the agent's own actions.
  const sinceId = await latestActionId(rootUrl);

  // 5. Triage — the agent under test.
  say(`running agent: ${agent.name}`);
  await agent.triage({ gmail, userId, brief: TRIAGE_BRIEF });

  // 6. Observe + grade.
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

  say("grading");
  const ctx: GradeCtx = { scenario, fixture, injected, probe, prior, anchor };
  const verdict = await gradeRun(outcome, ctx, {
    model: opts.models?.judge,
    useJudge: opts.useJudge,
  });

  // 7. Reset so runs are isolated (audit.db survives).
  if (opts.resetAfter !== false) {
    say("resetting sandbox to pristine snapshot");
    await resetSandbox(`after eval: ${scenario.id}`, rootUrl);
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
  };
}
