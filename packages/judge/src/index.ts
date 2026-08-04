// @sonata/judge — scoring a simulated workday.
//
// Two halves that never mix. `checklist` and `autonomy` are deterministic: same
// artifact in, same numbers out, no key, no network. `prompt`, `project` and `run`
// are the model's half, and everything they touch is pure up to a single
// `completeJSON` call, so an old run can be re-judged with a new model or a
// rewritten prompt months later with nothing live attached.

export * from "./autonomy";
export * from "./checklist";
export * from "./controls";
export * from "./project";
export * from "./prompt";
export * from "./run";
export * from "./store";
