import type { BenchmarkPlan, Cell } from "./plan";

// What a matrix will cost and how long it will take, computed WITHOUT calling
// anything. This is the whole of `--dry-run`.
//
// The real figure always comes from OpenRouter's own `usage.cost`, metered per
// call in the engine and summed into `EpisodeVerdict.cost`. This module exists
// for the question asked before that: a 5 x 6 x 3 matrix is ninety episodes, and
// "roughly forty dollars and three hours" versus "roughly four hundred dollars
// and thirty hours" is a decision, not a detail. Nobody should have to start a
// run to find out which one they are about to do.

/** OpenRouter list price, USD per million tokens. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Prices for the models the benchmark actually runs. Deliberately a short,
 * hand-kept list rather than a fetch: a dry-run must work offline, and a table
 * that is a few percent stale still answers the only question being asked.
 * Anything missing is reported as unpriced rather than guessed — see
 * `PlanEstimate.unpriced`.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "anthropic/claude-haiku-4.5": { inputPerMTok: 1, outputPerMTok: 5 },
  "anthropic/claude-sonnet-4.5": { inputPerMTok: 3, outputPerMTok: 15 },
  "anthropic/claude-opus-4.1": { inputPerMTok: 15, outputPerMTok: 75 },
  "openai/gpt-5": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "openai/gpt-5-mini": { inputPerMTok: 0.25, outputPerMTok: 2 },
  "google/gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10 },
  "google/gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
};

/** The three things that spend money in an episode. */
export type BenchRole = "agent" | "director" | "judge";

/**
 * The shape of one role's model usage over a day. Every field is a per-episode
 * average, not a bound: the estimate is a forecast, and pretending otherwise by
 * quoting worst cases would make every dry-run say "don't".
 */
export interface RoleProfile {
  role: BenchRole;
  /** Calls on every tick of the day. */
  callsPerTick: number;
  /** Calls made once per episode however long it is — the judge's single pass. */
  callsPerEpisode: number;
  /** Prompt tokens on the first call of the day. */
  promptTokens: number;
  /**
   * Extra prompt tokens per tick already elapsed. The agent re-reads a growing
   * conversation every tick, so a flat per-call figure understates a long day by
   * a factor that grows with the day — which is precisely the case a dry-run is
   * meant to warn about.
   */
  promptGrowthPerTick: number;
  completionTokens: number;
  /** Wall-clock seconds one call of this shape takes, end to end. */
  secondsPerCall: number;
}

/**
 * Defaults measured off the Gmail eval's runs, rounded to the nearest hundred
 * tokens. The agent calls twice a tick (a turn, then a tool-result turn); the
 * director once, and only when something addressed it, which averages out below
 * one; the judge once at the end over the whole timeline.
 */
export const DEFAULT_ROLES: RoleProfile[] = [
  {
    role: "agent",
    callsPerTick: 2,
    callsPerEpisode: 0,
    promptTokens: 4000,
    promptGrowthPerTick: 900,
    completionTokens: 400,
    secondsPerCall: 9,
  },
  {
    role: "director",
    callsPerTick: 0.6,
    callsPerEpisode: 0,
    promptTokens: 2500,
    promptGrowthPerTick: 250,
    completionTokens: 300,
    secondsPerCall: 6,
  },
  {
    role: "judge",
    callsPerTick: 0,
    callsPerEpisode: 1,
    promptTokens: 6000,
    promptGrowthPerTick: 700,
    completionTokens: 1500,
    secondsPerCall: 30,
  },
];

/** Ticks in a normal simulated workday: 8 hours at 15 simulated minutes a tick. */
export const DEFAULT_TICKS = 32;

/** The model every role except the agent runs on — see `harnessModel`. */
export const DEFAULT_HARNESS_MODEL = "anthropic/claude-haiku-4.5";

export interface EstimateOptions {
  /** Per-scenario tick counts, from `plannedTicks(spec)`. */
  ticksByScenario?: Record<string, number>;
  /** Used for any scenario absent from `ticksByScenario`. */
  ticksPerEpisode?: number;
  roles?: RoleProfile[];
  prices?: Record<string, ModelPrice>;
  /**
   * The model the director and judge run on. Held fixed across the matrix on
   * purpose: the benchmark varies the AGENT, and letting the world and its scorer
   * change model with it would mean every row was measured in a different world.
   */
  harnessModel?: string;
}

export interface RoleEstimate {
  role: BenchRole;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  usd: number;
  seconds: number;
  /** False when the model has no price row; its `usd` is 0 and understates. */
  priced: boolean;
}

export interface CellEstimate {
  cell: Cell;
  ticks: number;
  roles: RoleEstimate[];
  calls: number;
  promptTokens: number;
  completionTokens: number;
  usd: number;
  seconds: number;
}

export interface ModelEstimate {
  model: string;
  cells: number;
  usd: number;
  seconds: number;
}

export interface PlanEstimate {
  benchmarkId: string;
  cells: CellEstimate[];
  calls: number;
  promptTokens: number;
  completionTokens: number;
  usd: number;
  /** Cells run one at a time (see ./run), so this is the sum, not the max. */
  seconds: number;
  byModel: ModelEstimate[];
  /** Models with no price row. Their spend is missing from `usd` entirely. */
  unpriced: string[];
}

function tokenCost(price: ModelPrice, promptTokens: number, completionTokens: number): number {
  return (promptTokens * price.inputPerMTok + completionTokens * price.outputPerMTok) / 1_000_000;
}

/**
 * One role over `ticks` ticks.
 *
 * Per-tick calls are priced against the context as it stood on their tick, so the
 * prompt total is an arithmetic series rather than `calls x promptTokens`:
 *
 *   sum over t of (base + growth*t) = ticks*base + growth*ticks*(ticks-1)/2
 *
 * Per-episode calls are priced against the end-of-day context, since the judge
 * reads the finished timeline.
 */
export function estimateRole(
  profile: RoleProfile,
  ticks: number,
  model: string,
  prices: Record<string, ModelPrice>,
): RoleEstimate {
  const t = Math.max(0, Math.floor(ticks));
  const tickCalls = profile.callsPerTick * t;
  const perTickPrompt =
    profile.callsPerTick *
    (t * profile.promptTokens + profile.promptGrowthPerTick * ((t * (t - 1)) / 2));
  const episodePrompt =
    profile.callsPerEpisode * (profile.promptTokens + profile.promptGrowthPerTick * t);

  const calls = tickCalls + profile.callsPerEpisode;
  const promptTokens = perTickPrompt + episodePrompt;
  const completionTokens = calls * profile.completionTokens;
  const price = prices[model];

  return {
    role: profile.role,
    model,
    calls,
    promptTokens,
    completionTokens,
    usd: price ? tokenCost(price, promptTokens, completionTokens) : 0,
    seconds: calls * profile.secondsPerCall,
    priced: price !== undefined,
  };
}

/** Every role in one cell. The agent runs on the cell's model; nothing else does. */
export function estimateCell(cell: Cell, opts: EstimateOptions = {}): CellEstimate {
  const roles = opts.roles ?? DEFAULT_ROLES;
  const prices = opts.prices ?? MODEL_PRICES;
  const harness = opts.harnessModel ?? DEFAULT_HARNESS_MODEL;
  const ticks = opts.ticksByScenario?.[cell.scenarioId] ?? opts.ticksPerEpisode ?? DEFAULT_TICKS;

  const estimates = roles.map((p) =>
    estimateRole(p, ticks, p.role === "agent" ? cell.model : harness, prices),
  );
  const sum = (pick: (r: RoleEstimate) => number) => estimates.reduce((a, r) => a + pick(r), 0);

  return {
    cell,
    ticks,
    roles: estimates,
    calls: sum((r) => r.calls),
    promptTokens: sum((r) => r.promptTokens),
    completionTokens: sum((r) => r.completionTokens),
    usd: sum((r) => r.usd),
    seconds: sum((r) => r.seconds),
  };
}

/**
 * What is left to run, priced.
 *
 * Estimates `plan.pending` and not `plan.cells`: a dry-run after an interrupted
 * benchmark is asking "what will finishing this cost", and quoting the cost of
 * work already paid for would be the wrong answer to that question.
 */
export function estimatePlan(plan: BenchmarkPlan, opts: EstimateOptions = {}): PlanEstimate {
  const cells = plan.pending.map((c) => estimateCell(c, opts));
  const sum = (pick: (c: CellEstimate) => number) => cells.reduce((a, c) => a + pick(c), 0);

  const byModel = new Map<string, ModelEstimate>();
  const unpriced = new Set<string>();
  for (const c of cells) {
    const row = byModel.get(c.cell.model) ?? { model: c.cell.model, cells: 0, usd: 0, seconds: 0 };
    row.cells += 1;
    row.usd += c.usd;
    row.seconds += c.seconds;
    byModel.set(c.cell.model, row);
    for (const r of c.roles) if (!r.priced) unpriced.add(r.model);
  }

  return {
    benchmarkId: plan.matrix.id,
    cells,
    calls: sum((c) => c.calls),
    promptTokens: sum((c) => c.promptTokens),
    completionTokens: sum((c) => c.completionTokens),
    usd: sum((c) => c.usd),
    seconds: sum((c) => c.seconds),
    byModel: [...byModel.values()].sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model)),
    unpriced: [...unpriced].sort(),
  };
}

/** "2h 14m", "9m 30s", "45s" — a duration a person can act on. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "$0.0412" under a dollar, "$41.23" over it — never lose the leading digits. */
export function formatUsd(usd: number): string {
  return usd >= 1 || usd <= -1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** The `--dry-run` printout. */
export function formatEstimate(est: PlanEstimate): string {
  const n = (x: number) => Math.round(x).toLocaleString("en-US");
  const lines = [
    `${est.benchmarkId}: ${est.cells.length} episode(s) to run`,
    `  estimated spend    ${formatUsd(est.usd)}`,
    `  estimated duration ${formatDuration(est.seconds)} (episodes run one at a time)`,
    `  model calls        ${n(est.calls)}`,
    `  tokens             ${n(est.promptTokens)} in / ${n(est.completionTokens)} out`,
    "",
  ];
  for (const m of est.byModel) {
    const spend = `${formatUsd(m.usd)}  ${formatDuration(m.seconds)}`;
    lines.push(`  ${m.model.padEnd(30)} ${m.cells} ep  ${spend}`);
  }
  if (est.unpriced.length > 0) {
    const names = est.unpriced.join(", ");
    lines.push("", `  NO PRICE for ${names} — the real spend is higher than this.`);
  }
  return lines.join("\n");
}
