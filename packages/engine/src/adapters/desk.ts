import { resolveTwinApiUrl, type DeskDiff, type DeskSnapshot, type TwinAdapter } from "@sonata/core";
import type { DeskAssessment } from "@sonata/desks";
import { createTwinHttp, type TwinHttpOptions } from "../http";
import { projectTwinTrace } from "../project";
import { auditViaActivity, healthViaApi, resetViaApi } from "./shared";

export interface DeskAdapterOptions extends Omit<TwinHttpOptions, "baseUrl"> {
  baseUrl?: string;
}

export function createDeskAdapter(opts: DeskAdapterOptions = {}): TwinAdapter {
  const baseUrl = resolveTwinApiUrl("desk", process.env, { override: opts.baseUrl });
  const http = createTwinHttp("desk", { ...opts, baseUrl });
  return {
    name: "desk",
    baseUrl,
    health: () => healthViaApi(http, "desk"),
    async snapshot() {
      const state = await http.get<Omit<DeskSnapshot, "twin">>("/api/sandbox/snapshot");
      // The event log is the evidence a continuity week is assessed on. A
      // snapshot that carried only the records would still diff and still
      // render, and would quietly lose every fact about when something
      // happened — which is the whole question being asked.
      if (!Array.isArray(state.records) || !Array.isArray(state.events)) {
        throw new Error("Desk snapshot omitted records or its event log; evidence is incomplete");
      }
      return { ...state, twin: "desk", capturedAt: state.capturedAt ?? Date.now() };
    },
    diff: (before, after) => diffDesk(before as DeskSnapshot, after as DeskSnapshot),
    renderDiff: (diff) => renderDeskDiff(diff as DeskDiff),
    async inject(body) {
      // A desk week has no scripted beats: its world moves when the domain's own
      // schedule says so, at `advance`. Injecting one here would put a fact into
      // the ledger that no rule produced and no assessment expects.
      throw new Error(`The desk does not accept scripted beats (${body.twin}:${body.kind}); its world advances on the authored schedule`);
    },
    async seed() {
      await http.post("/api/sandbox/seed", { twin: "desk" });
    },
    reset: () => resetViaApi(http, "episode reset"),
    auditSince: (sinceId) => auditViaActivity(http, "desk", sinceId, { sinceId }),
    projectTrace: (trace) => projectTwinTrace(trace, "desk"),
  };
}

/**
 * The trusted half of a desk, kept off `TwinAdapter` on purpose.
 *
 * Moving the clock and reading the assessment are the two things that must
 * never be reachable from the agent's side of the run. Every other twin's
 * adapter is a uniform surface the harness treats identically; these are the
 * engine's own levers, so they are asked for by name — a caller that has one
 * has gone looking for it.
 */
export interface DeskControl {
  /** Fire the week's scheduled consequences up to this instant. */
  advance(atISO: string, phase: "before" | "after"): Promise<void>;
  /** The deterministic assessment. Evidence for the evaluator, never the agent. */
  assess(completedThrough: string | null): Promise<DeskAssessment & { caseId: string }>;
}

export function createDeskControl(opts: DeskAdapterOptions = {}): DeskControl {
  const baseUrl = resolveTwinApiUrl("desk", process.env, { override: opts.baseUrl });
  const http = createTwinHttp("desk", { ...opts, baseUrl });
  return {
    async advance(atISO, phase) {
      await http.post("/api/sandbox/advance", { at: atISO, phase });
    },
    assess: (completedThrough) =>
      http.post<DeskAssessment & { caseId: string }>("/api/sandbox/assess", { completedThrough }),
  };
}

export function diffDesk(before: DeskSnapshot, after: DeskSnapshot): DeskDiff {
  const previous = new Map(before.records.map((row) => [row.id, row.data]));
  const current = new Map(after.records.map((row) => [row.id, row.data]));
  const records: DeskDiff["records"] = [];
  let unchangedCount = 0;
  for (const id of new Set([...previous.keys(), ...current.keys()])) {
    const a = previous.get(id);
    const b = current.get(id);
    if (JSON.stringify(a) === JSON.stringify(b)) unchangedCount++;
    else records.push({ id, ...(a ? { before: a } : {}), ...(b ? { after: b } : {}) });
  }
  const known = new Set(before.events.map((event) => event.id));
  return { twin: "desk", records, events: after.events.filter((event) => !known.has(event.id)), unchangedCount };
}

export function renderDeskDiff(diff: DeskDiff): string {
  // The actor stays on every line. A desk ledger holds the world's scheduled
  // consequences next to the agent's own work, and a reader who cannot tell
  // them apart will credit the agent with a receipt that simply arrived.
  return [
    "Desk ledger changes (before = as the week opened; after = as it ended).",
    JSON.stringify({ records: diff.records, events: diff.events }),
    `${diff.unchangedCount} record(s) untouched`,
  ].join("\n");
}
