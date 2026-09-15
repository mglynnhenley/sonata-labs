/**
 * Does a continuity week survive a real workplace?
 *
 * Provisions an actual Docker workplace for E01, talks to the desk container
 * through the two credentials the run issues, moves the week and asks for the
 * mark. No model is called: this is about whether the plumbing holds, not about
 * whether anything is good at the job.
 */
import { prepareWorkplace } from "../src/lib/engine/workplace";
import { createDeskAdapter, createDeskControl } from "@sonata/engine";
import { getScenario } from "@sonata/scenarios";

const spec = getScenario("electricity-continuity-e01")!;
const runId = `e01smoke${Date.now().toString(36)}`;
const workplace = await prepareWorkplace(runId, ["desk"], false, { deskCase: spec.benchmark!.caseId });

function log(step: string, detail: unknown) {
  console.log(`${step.padEnd(34)} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

try {
  await workplace.start(new AbortController().signal);
  log("workplace started", { desk: workplace.urls.desk, isolation: "docker-per-run-v1" });

  const credentials = { baseUrl: workplace.urls.desk, token: workplace.agentToken, controlToken: workplace.controlToken };
  const adapter = createDeskAdapter(credentials);
  const control = createDeskControl(credentials);

  log("health", await adapter.health());
  await adapter.seed(spec);
  log("seeded", { records: (await adapter.snapshot() as { records: unknown[] }).records.length });

  // The agent's own view: its tools, over its own credential, through the
  // container's published port.
  const tools = await fetch(`${workplace.urls.desk}/api/tools`, {
    headers: { authorization: `Bearer ${workplace.agentToken}` },
  }).then((r) => r.json()) as { caseId: string; tools: Array<{ name: string }> };
  log("agent sees its own week", { case: tools.caseId, tools: tools.tools.length });

  // The agent cannot reach the levers that decide its result.
  const forbidden = await fetch(`${workplace.urls.desk}/api/sandbox/assess`, {
    method: "POST",
    headers: { authorization: `Bearer ${workplace.agentToken}`, "content-type": "application/json" },
    body: JSON.stringify({ completedThrough: null }),
  });
  log("agent asking for the mark", { status: forbidden.status });

  // Monday morning, the first few opportunities.
  const instants = spec.clock.tickISOs!.slice(0, 8);
  for (const at of instants) {
    await control.advance(at, "before");
    await control.advance(at, "after");
  }
  log("advanced", { through: instants[instants.length - 1], opportunities: instants.length });

  const after = await adapter.snapshot() as { records: unknown[]; events: Array<{ actor: string }> };
  const byActor = after.events.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.actor]: (acc[e.actor] ?? 0) + 1 }), {});
  log("ledger", { records: after.records.length, events: byActor });
  log("agent audit log", { rows: (await adapter.auditSince(0)).length });

  const assessment = await control.assess(instants[instants.length - 1]!);
  const marks = assessment.criteria.flatMap((c) => c.units.map((u) => u.score));
  log("assessment", { criteria: assessment.criteria.length, unitMarks: marks.length, distinct: [...new Set(marks)] });

  console.log("\nE01 ran in a real workplace.");
} finally {
  await workplace.stop();
  console.log("workplace torn down.");
}
