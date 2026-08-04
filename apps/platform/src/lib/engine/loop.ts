import type { ByTwin } from "@sonata/core";
import {
  TwinHttp,
  createAdapters,
  createAgent,
  createDirector,
  runEpisode,
  toolsFor,
  traceCost,
} from "@sonata/engine";
import type { RunEpisodeFn } from "./contract";

// The only place the dashboard touches @sonata/engine.
//
// The engine takes its parts rather than a URL: adapters for the twins, tools
// for the agent, a director for the world. That is right for a package — a
// benchmark harness or a customer's own agent slots in at any of those seams —
// but the dashboard only ever wants one arrangement of them, so it is assembled
// here, once, and every other module in this folder works in terms of
// `RunEpisodeFn`.

export const engineLoop: RunEpisodeFn = async (opts) => {
  const seed = opts.seedWorld ?? true;

  // The agent's tools talk to the twins over the same HTTP the adapters use;
  // one client per twin, so a run opens three connections rather than thirty.
  const http: ByTwin<TwinHttp> = {};
  for (const twin of opts.twins) {
    const baseUrl = opts.twinUrls[twin];
    if (baseUrl) http[twin] = new TwinHttp({ baseUrl });
  }

  // Only the twins this run attached. The engine narrows to the ones the spec
  // names, but the caller can narrow further — and an adapter that is present is
  // one the run will reset, seed and inject into, whether or not it was asked for.
  const adapters = createAdapters({
    ...(opts.twinUrls.gmail ? { gmail: { baseUrl: opts.twinUrls.gmail } } : {}),
    ...(opts.twinUrls.slack ? { slack: { baseUrl: opts.twinUrls.slack } } : {}),
    ...(opts.twinUrls.calendar ? { calendar: { baseUrl: opts.twinUrls.calendar } } : {}),
  }).filter((adapter) => opts.twins.includes(adapter.name));

  const result = await runEpisode({
    spec: opts.spec,
    runId: opts.runId,
    model: opts.model,
    adapters,
    agent: createAgent({
      spec: opts.spec,
      tools: toolsFor(opts.twins, http),
      model: opts.model,
    }),
    director: createDirector({
      spec: opts.spec,
      ...(opts.directorModel ? { model: opts.directorModel } : {}),
    }),
    // Reset then seed: two runs of the same scenario have to start from the same
    // state, or the second one is scored against the first one's leftovers.
    seedWorld: seed,
    resetTwins: seed,
    ...(opts.onTick ? { onTick: opts.onTick } : {}),
  });

  return {
    run: result.run,
    trace: result.trace,
    audit: result.audit,
    // Summed from the calls themselves, so the figure on the results page is
    // re-derivable from the saved trace rather than trusted.
    cost: traceCost(result.trace),
    preflight: result.preflight,
  };
};
