import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { CONTINUITY_CASES } from '../src/benchmarks/index';
import { createDeskEnvironment } from '../src/benchmarks/runtime';
import { createReferenceAgent } from '../src/benchmarks/reference';
import { runEpisode } from '../src/run';

const args = process.argv.slice(2);
function option(name: string) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
const caseId = option('--case');
const route = option('--route');
const output = resolve(option('--out') ?? `.context/continuity-runs/${Date.now()}`);
const cases = CONTINUITY_CASES.filter(c => !caseId || c.domain.id === caseId || c.spec.id === caseId);
if (!cases.length) throw new Error(`Unknown case ${caseId}`);
mkdirSync(output, { recursive: true });
const summary: Array<Record<string, unknown>> = [];
for (const desk of cases) {
  const routes = Object.entries({ ...desk.routes, no_action: [] }).filter(([name]) => !route || name === route);
  if (!routes.length) throw new Error(`Unknown route ${route} for ${desk.domain.id}`);
  for (const [name, actions] of routes) {
    const id = `reference-${desk.domain.id}-${name}`;
    const environment = createDeskEnvironment(desk, join(output, `${id}.desk`));
    try {
      const result = await runEpisode({
        spec: desk.spec, runId: id, model: 'reference-policy (no model evaluated)', adapters: [], environment,
        agent: createReferenceAgent(actions, environment.tools),
        director: { react: async () => [], lastNote: () => undefined },
      });
      const artifact = { ...result.run, spec: desk.spec, audit: result.audit, verification: { kind: 'authored-reference', modelEvaluated: false, costUsd: 0 } };
      writeFileSync(join(output, `${id}.json`), JSON.stringify(artifact, null, 2) + '\n');
      writeFileSync(join(output, `${id}.trace.json`), JSON.stringify(result.trace, null, 2) + '\n');
      const errors = result.trace.toolCalls.filter(call => call.error || (call.result && typeof call.result === 'object' && ('error' in call.result || ('ok' in call.result && call.result.ok === false))));
      const row = { case: desk.domain.id, route: name, status: result.run.status, ticks: result.run.ticks.length,
        calls: result.trace.toolCalls.length, toolErrors: errors.map(call => ({ name: call.name, tick: call.tick, error: call.error ?? call.result })),
        utility: result.run.benchmark?.utility.score, reporting: result.run.benchmark?.reporting.score,
        artifact: join(output, `${id}.json`), error: result.run.error ?? null };
      summary.push(row);
      console.log(JSON.stringify(row));
      if (result.run.status !== 'done' || result.run.ticks.length !== 180) process.exitCode = 1;
      if (['successful', 'reference', 'alternative', 'mirror_allocation', 'accessible_collection', 'receipt_boundaries'].includes(name) && (errors.length > 0 || result.run.benchmark?.utility.score !== 100)) process.exitCode = 1;
      if (['late', 'preventive', 'late_safe_amendment', 'next_day_recovery', 'no_action'].includes(name) && (errors.length > 0 || result.run.benchmark?.utility.score == null || result.run.benchmark.utility.score >= 100)) process.exitCode = 1;
    } finally { environment.close(); }
  }
}
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ modelEvaluated: false, costUsd: 0, runs: summary }, null, 2) + '\n');
console.log(`Reference artifacts: ${output}`);
