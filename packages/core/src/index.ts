// @sonata/core — the contracts every twin, the engine, the judge and the
// dashboard code against. Types, the failure-mode catalog, and pure helpers
// only: nothing here does I/O or calls a model, so importing it costs nothing
// and pulls in no runtime.

export * from "./types/world";
export * from "./types/episode";
export * from "./types/run";
export * from "./types/judge";
export * from "./failureModes";
export * from "./twin";
export * from "./clock";
export * from "./score";
export * from "./cast";
export * from "./spec";
