// The bridge between the dashboard and the episode engine.
//
// Everything a route or the CLI needs to start a day, watch it, stop it, score
// it and benchmark it — and one seam (`./contract`) that the engine plugs into.
// The dashboard's own store, twin supervision and artifact writers are reused
// rather than re-implemented: this folder adds the run loop and nothing else.

export * from "./contract";
export * from "./episode";
export * from "./scenarios";
export * from "./verdict";
export * from "./preflight";
export * from "./bench";
