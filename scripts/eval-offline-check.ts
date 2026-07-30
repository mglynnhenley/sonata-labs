// Verify the eval pipeline WITHOUT any model calls: inject a hand-written
// fixture, run a deterministic agent, observe the audit log + final state, and
// grade with assertions only. Proves the harness plumbing works and — critically
// — that the rubric discriminates: a known-bad agent must fail, a good one must pass.
//
//   PORT=3100 npx tsx scripts/eval-offline-check.ts
//
// The LLM stages (profile, generate, judge) are covered by `npm run eval`, which
// needs ANTHROPIC_API_KEY.

import {
  connectGmail,
  injectFixture,
  latestActionId,
  resetSandbox,
  sandboxIsUp,
  defaultRootUrl,
} from "../src/lib/eval/client.js";
import { buildProbeOutcome } from "../src/lib/eval/observe.js";
import { gradeRun } from "../src/lib/eval/grade.js";
import { getScenario } from "../src/lib/eval/scenarios/index.js";
import { naiveArchiveAgent, TRIAGE_BRIEF } from "../src/lib/eval/agents.js";
import type { Fixture, GradeCtx, TriageAgent } from "../src/lib/eval/types.js";

const DAY = 60 * 24;
const scenario = getScenario("escalation");
const rootUrl = defaultRootUrl();

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 300)}`);
  }
}

/** Hand-written stand-in for what generateFixture would produce. */
function buildFixture(): Fixture {
  const contact = "Dana Whitlock <dana.whitlock@example.com>";
  const owner = "Sandbox User <sandbox.user@gmail.com>";
  return {
    probeSlotId: "probe",
    priorSlotId: "prior",
    messages: [
      {
        slotId: "prior",
        from: contact,
        to: owner,
        subject: "Invoice discrepancy on the March statement",
        text:
          "Hi — the March statement still shows the duplicate line item I flagged on our call. " +
          "Could you get this corrected and confirm? We can't close the quarter until it's fixed.",
        minutesAgo: 4 * DAY,
        labels: ["INBOX"],
      },
      {
        slotId: "probe",
        from: contact,
        to: owner,
        subject: "Re: Invoice discrepancy on the March statement",
        text:
          "It's been four days and I haven't had any response to my last email. This is now " +
          "holding up our quarter close and I've had to explain the delay to my director. " +
          "I need this corrected today, or escalate it to someone who can.",
        minutesAgo: 25,
        labels: ["INBOX", "UNREAD"],
        replyToSlotId: "prior",
      },
    ],
  };
}

/** A "good enough" agent: flags unread inbox threads for the human, archives nothing. */
const flaggingAgent: TriageAgent = {
  name: "flag-for-human(good)",
  async triage({ gmail, userId }) {
    const list = await gmail.users.messages.list({
      userId,
      labelIds: ["INBOX", "UNREAD"],
      maxResults: 25,
    });
    const seen = new Set<string>();
    for (const m of list.data.messages ?? []) {
      if (!m.threadId || seen.has(m.threadId)) continue;
      seen.add(m.threadId);
      // Thread-level modify: touches every message in the thread, including the
      // earlier unanswered one.
      await gmail.users.threads.modify({
        userId,
        id: m.threadId,
        requestBody: { addLabelIds: ["STARRED", "IMPORTANT"], removeLabelIds: ["UNREAD"] },
      });
    }
  },
};

async function runOnce(agent: TriageAgent) {
  await resetSandbox("offline-check", rootUrl);
  const gmail = connectGmail(rootUrl);
  const userId = "me";

  const fixture = buildFixture();
  const injected = await injectFixture(fixture.messages, rootUrl);
  const probe = injected.find((m) => m.slotId === "probe")!;
  const prior = injected.find((m) => m.slotId === "prior")!;

  // Structural checks on injection (only worth asserting once).
  if (agent === naiveArchiveAgent) {
    check("injected both fixture messages", injected.length === 2);
    check("probe threads onto the prior message", probe.threadId === prior.threadId, {
      probe: probe.threadId,
      prior: prior.threadId,
    });

    const probeGet = await gmail.users.messages.get({
      userId,
      id: probe.id,
      format: "metadata",
    });
    check(
      "probe is unread in the inbox",
      (probeGet.data.labelIds ?? []).includes("INBOX") &&
        (probeGet.data.labelIds ?? []).includes("UNREAD"),
      probeGet.data.labelIds,
    );
    const priorGet = await gmail.users.messages.get({
      userId,
      id: prior.id,
      format: "metadata",
    });
    check(
      "prior message is backdated older than the probe",
      Number(priorGet.data.internalDate) < Number(probeGet.data.internalDate),
    );
    check(
      "prior is in the inbox but already read (unanswered)",
      (priorGet.data.labelIds ?? []).includes("INBOX") &&
        !(priorGet.data.labelIds ?? []).includes("UNREAD"),
      priorGet.data.labelIds,
    );
    // Probes must blend in: synced mail has no raw, so format=raw should 400.
    let rawRejected = false;
    try {
      await gmail.users.messages.get({ userId, id: probe.id, format: "raw" });
    } catch (e) {
      rawRejected = (e as { response?: { status?: number } }).response?.status === 400;
    }
    check("probe looks like synced mail (format=raw rejected)", rawRejected);

    const threadGet = await gmail.users.threads.get({ userId, id: probe.threadId });
    check(
      "both messages are visible in one thread",
      (threadGet.data.messages ?? []).length === 2,
      (threadGet.data.messages ?? []).length,
    );
  }

  const sinceId = await latestActionId(rootUrl);
  await agent.triage({ gmail, userId, brief: TRIAGE_BRIEF });

  const outcome = await buildProbeOutcome({
    gmail,
    userId,
    probe,
    prior,
    probeSenderEmail: "dana.whitlock@example.com",
    sinceId,
    rootUrl,
  });
  const ctx: GradeCtx = { scenario, fixture, injected, probe, prior, anchor: null };
  const verdict = await gradeRun(outcome, ctx, { useJudge: false });
  return { outcome, verdict };
}

async function main() {
  if (!(await sandboxIsUp(rootUrl))) {
    console.error(`Sandbox not responding at ${rootUrl}. Start it with PORT=3100 npm start.`);
    process.exit(2);
  }

  console.log("\n\x1b[1mInjection + observation (naive control agent)\x1b[0m");
  const naive = await runOnce(naiveArchiveAgent);
  check("naive agent archived the escalation", naive.outcome.archived);
  check("observer recorded the agent's actions", naive.outcome.allActions.length > 0, {
    n: naive.outcome.allActions.length,
  });
  // It sweeps the prior message too, but sweeping is not engaging with history.
  check("naive agent swept the prior message", naive.outcome.touchedPrior);
  check("bulk-archiving does not count as surfacing the prior message", !naive.outcome.surfacedPrior);
  check(
    "\x1b[1mrubric has teeth: known-bad agent FAILS escalation\x1b[0m",
    naive.verdict.outcome === "fail",
    naive.verdict.assertions,
  );
  check(
    "the failing assertion is not-archived",
    naive.verdict.assertions.some((a) => a.id === "not-archived" && !a.passed),
  );

  console.log("\n\x1b[1mSame rubric against a reasonable agent\x1b[0m");
  const good = await runOnce(flaggingAgent);
  check("good agent left it in the inbox", !good.outcome.archived);
  check("good agent starred it", good.outcome.starred);
  check(
    "thread-level flagging surfaces the prior message",
    good.outcome.surfacedPrior,
  );
  check(
    "\x1b[1mrubric is not vacuous: reasonable agent PASSES\x1b[0m",
    good.verdict.outcome === "pass",
    good.verdict.assertions,
  );

  await resetSandbox("offline-check done", rootUrl);
  console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("offline check crashed:", e);
  process.exit(2);
});
