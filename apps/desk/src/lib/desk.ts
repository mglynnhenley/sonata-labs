import { mkdirSync } from "node:fs";
import path from "node:path";
import { CONTINUITY_CASES, SqliteDeskStore, type DeskCase, type DeskEvent } from "@sonata/desks";

// The desk service's whole job: hold one week's ledger, apply the domain's rules
// to what the agent asks, and let the trusted engine move the clock.
//
// The one rule worth stating out loud is that the agent never says what time it
// is. Every rule in a continuity domain is written against a simulated instant —
// whether a source has been superseded, whether a review window has opened,
// whether a submission is late — so a tool call carrying its own `at` would let
// a model choose which deadlines it had met. The instant lives here, and only a
// caller holding the control credential can move it.

export class DeskError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

interface Desk {
  desk: DeskCase;
  store: SqliteDeskStore;
  /** Simulated now. Set by the engine at each interval; never by the agent. */
  at: string;
  seeded: boolean;
}

const g = globalThis as unknown as { __sonataDesk?: Desk };

function dbPath(): string {
  const file = process.env.SONATA_DESK_DB || path.join(process.cwd(), "data", "desk.db");
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/** The case this process serves, named by env so one image serves any week. */
export function caseId(): string {
  const id = process.env.SONATA_DESK_CASE?.trim();
  if (!id) throw new DeskError("This desk has no case: set SONATA_DESK_CASE.", 503);
  return id;
}

export function desk(): Desk {
  if (g.__sonataDesk) return g.__sonataDesk;
  const id = caseId();
  const found = CONTINUITY_CASES.find((entry) => entry.domain.id === id);
  if (!found) throw new DeskError(`Unknown desk case "${id}".`, 503);
  const store = new SqliteDeskStore(dbPath());
  // The week opens at its own first opportunity, not at whatever the host clock
  // says. A desk started at 3am UTC is still a Monday morning.
  const at = found.spec.clock.tickISOs?.[0] ?? found.spec.clock.startISO;
  g.__sonataDesk = { desk: found, store, at, seeded: store.list().length > 0 };
  return g.__sonataDesk;
}

export function health() {
  const state = desk();
  return {
    status: "ok",
    caseId: state.desk.domain.id,
    scenarioId: state.desk.spec.id,
    seeded: state.seeded,
    simTimeISO: state.at,
    records: state.store.list().length,
  };
}

/** The verbs this week offers, for a client that has no MCP manifest. */
export function tools() {
  return {
    caseId: desk().desk.domain.id,
    tools: desk().desk.domain.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      mutation: tool.mutation,
    })),
  };
}

export function seed() {
  const state = desk();
  if (state.seeded) throw new DeskError("This desk is already seeded; reset it first.", 409);
  state.store.transaction(() => state.desk.domain.seed(state.store));
  state.seeded = true;
  return { ok: true, caseId: state.desk.domain.id, records: state.store.list().length };
}

export function reset() {
  const state = desk();
  for (const row of state.store.list()) state.store.put(row.id, undefined);
  // The ledger is append-only by design, so a reset rebuilds the file rather
  // than deleting rows out of it: an "empty" event table with a live rowid
  // counter would renumber the next week's evidence.
  state.store.close();
  g.__sonataDesk = undefined;
  const fresh = desk();
  fresh.store.transaction(() => fresh.desk.domain.seed(fresh.store));
  fresh.seeded = true;
  return { ok: true, caseId: fresh.desk.domain.id, records: fresh.store.list().length };
}

export function snapshot() {
  const state = desk();
  return {
    capturedAt: Date.now(),
    caseId: state.desk.domain.id,
    records: state.store.list(),
    events: state.store.events(),
  };
}

/**
 * The audit surface every twin owes the engine.
 *
 * Only the agent's own operations are reported. The world's scheduled
 * consequences — a receipt arriving, a review window closing — are in the
 * snapshot's event log, where the assessment reads them, but they are not the
 * agent's actions and crediting them as such would make a desk that did nothing
 * look busy.
 */
export function activity(sinceId: number) {
  const state = desk();
  return state.store
    .events()
    .filter((event: DeskEvent) => event.id > sinceId && event.actor === "agent")
    .map((event: DeskEvent) => ({
      id: event.id,
      twin: "desk" as const,
      ts: Date.parse(event.at),
      method: "POST",
      endpoint: `/api/tools/${event.kind}`,
      actionType: event.kind,
      summary: JSON.stringify(event.data).slice(0, 500),
    }));
}

/** Move simulated time and let the week's own schedule fire. Trusted callers only. */
export function advance(at: string, phase: "before" | "after") {
  const state = desk();
  if (!Number.isFinite(Date.parse(at))) throw new DeskError("advance needs an ISO instant.");
  if (Date.parse(at) < Date.parse(state.at)) {
    throw new DeskError("Simulated time cannot run backwards.", 409);
  }
  state.at = at;
  state.store.transaction(() => state.desk.domain.advance(state.store, at, phase));
  return { ok: true, simTimeISO: state.at, phase };
}

export function execute(name: string, args: Record<string, unknown>) {
  const state = desk();
  if (!state.seeded) throw new DeskError("This desk has not been seeded.", 409);
  const tool = state.desk.domain.tools.find((entry) => entry.name === name);
  if (!tool) throw new DeskError(`No tool "${name}" on case ${state.desk.domain.id}.`, 404);
  return state.store.transaction(() => state.desk.domain.execute(state.store, name, args, state.at));
}

/** The deterministic assessment of the week. Evidence for the evaluator, never the agent. */
export function assess(completedThrough: string | null) {
  const state = desk();
  return { caseId: state.desk.domain.id, ...state.desk.domain.assess(state.store, completedThrough) };
}
