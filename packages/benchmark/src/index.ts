// @sonata/benchmark — the model-vs-model matrix. Scenarios x models x seeds,
// planned, priced, run, aggregated and rendered.
//
// Four of the five modules are pure functions over data (`plan`, `estimate`,
// `aggregate`, `table`); only `run` and `store` touch the world, and `run`
// reaches the engine through an injected port rather than an import. So the
// arithmetic behind the published table is reproducible from the saved
// artifacts, offline, with no key.

export * from "./plan";
export * from "./estimate";
export * from "./aggregate";
export * from "./store";
export * from "./run";
export * from "./table";
