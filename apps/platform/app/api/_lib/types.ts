import type {
  Clock,
  Criterion,
  EpisodeSpec,
  RunCost,
  RunStatus,
  TickRecord,
  TwinName,
  WorldSeed,
} from "@sonata/core";
import type { GeneratedWorld } from "@sonata/world";

// The wire shapes between the dashboard pages and the /api routes they own.
//
// Type-only apart from two tiny catalogs, so a client component can import this
// without pulling a single line of server code into the browser bundle. Every
// route below returns one of these verbatim — no page reshapes a response.

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

/**
 * What a clone contains, per surface. Shown in the preview *before* anything is
 * written, so "what will be generated" and "what exists" are the same numbers.
 *
 * Every field names a THING rather than an event, because two functions fill
 * this and they count different halves of the same word: `plannedCounts` counts
 * what a day's beats will add, `actualCounts` counts what the generated backlog
 * already holds. `threads` has always meant both — threads the day opens, and
 * threads sitting in the inbox — and the two surfaces below follow it.
 *
 * A world record saved before a surface existed carries no number for it, so
 * anything reading one off a stored `WorldCounts` has to treat absent as none.
 */
export interface WorldCounts {
  people: number;
  threads: number;
  messages: number;
  channels: number;
  slackMessages: number;
  events: number;
  /** CRM records across companies, contacts and deals — the pipeline's size. */
  records: number;
  documents: number;
}

export interface WorldSummary {
  id: string;
  /** The business name the seeder chose, e.g. "Northbeam Capital". */
  name: string;
  /** The one-paragraph business description, as generated. */
  description: string;
  /** What the user typed. Kept so a world can be re-generated from its brief. */
  brief: string;
  createdAt: number;
  counts: WorldCounts;
}

export interface WorldRecord extends WorldSummary {
  seed: WorldSeed;
  /**
   * The company's backlog — the days already behind it, written across every
   * surface at once by @sonata/world. Optional because a world can exist before
   * it has one (no model access, or a shipped day whose beats are the whole
   * story); when it is present, a run loads it into the twins before tick 0, and
   * that is the difference between an agent opening a working inbox and an agent
   * opening an empty one.
   *
   * Records written before a surface existed carry no seed for it, and
   * `buildSeedRequest` refuses one by name rather than posting an empty seed
   * over a twin — so this is `GeneratedWorld` as it was when the record was
   * saved, not necessarily as the type reads today.
   */
  clone?: GeneratedWorld;
}

export interface CastPreview {
  id: string;
  name: string;
  role: string;
  email: string;
  relationship: string;
}

export interface ChannelPreview {
  name: string;
  purpose: string;
  memberCount: number;
}

export interface BeatPreview {
  tick: number;
  /** Wall-clock label in the company's own offset, e.g. "09:15". */
  timeLabel: string;
  twin: TwinName;
  kind: string;
  summary: string;
}

export interface EpisodePreview {
  title: string;
  story: string;
  task: string;
  ticks: number;
  simMinutesPerTick: number;
  startISO: string;
  twins: TwinName[];
  beats: BeatPreview[];
  criteria: Array<{ description: string; twin: Criterion["twin"]; severity: Criterion["severity"] }>;
}

/**
 * The Preview step of the new-scenario flow. Generated once and parked as a
 * draft, so pressing Create commits exactly what was shown — no second model
 * call, no drift between the preview and the thing that gets built.
 */
export interface ScenarioDraft {
  draftId: string;
  brief: string;
  createdAt: number;
  /** True when this was assembled without a model — no API key, or the call failed. */
  offline: boolean;
  /**
   * Why the model was not used, when `offline`. A silent fallback is how a user
   * ends up believing they cloned their own business when they were handed a
   * stock template, so the reason travels with the draft and is shown.
   */
  offlineReason?: string;
  business: { name: string; industry: string; size: number; description: string };
  counts: WorldCounts;
  cast: CastPreview[];
  channels: ChannelPreview[];
  episode: EpisodePreview;
}

// ---------------------------------------------------------------------------
// Episodes (what the dashboard calls scenarios)
// ---------------------------------------------------------------------------

export interface EpisodeSummary {
  id: string;
  title: string;
  story: string;
  task: string;
  worldId: string;
  worldName: string;
  /** Null for scenarios written from scratch. */
  templateId: string | null;
  twins: TwinName[];
  counts: { beats: number; criteria: number; ticks: number };
  createdAt: number;
  lastRun: { runId: string; status: RunStatus; score: number | null; startedAt: number } | null;
}

export interface EpisodeRecord extends EpisodeSummary {
  spec: EpisodeSpec;
}

// ---------------------------------------------------------------------------
// Templates — read-only starting points, shipped with the product.
// ---------------------------------------------------------------------------

/** One service chip on a template card: "Gmail · 14 threads". */
export interface TemplateService {
  twin: TwinName;
  /** How much of it the day seeds. Every twin can be counted, so this is never absent. */
  count: number;
  /** Plural noun for the count: "threads", "channels", "events". */
  unit: string;
}

export interface TemplateSummary {
  id: string;
  title: string;
  /** Two lines. What the day is, and why it is hard. */
  description: string;
  services: TemplateService[];
  ticks: number;
  simMinutesPerTick: number;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunSummary {
  runId: string;
  specId: string;
  specTitle: string;
  model: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  /** Wall-clock, not simulated — how long the run actually took. */
  durationMs: number;
  /** Ticks recorded so far. */
  tickCount: number;
  plannedTicks: number;
  twins: TwinName[];
  /** Simulated time at the head of the story. Drives the live clock. */
  simTimeISO: string;
  paused: boolean;
  score: number | null;
  autonomy: number | null;
  cost: RunCost | null;
  error?: string;
}

export interface RunDetail extends RunSummary {
  story: string;
  task: string;
  clock: Clock;
  ticks: TickRecord[];
}

/** Poll response. `ticks` carries only what the caller has not seen. */
export interface RunPoll {
  run: RunSummary;
  ticks: TickRecord[];
  /** Pass back as `?sinceTick=` on the next poll. */
  nextSinceTick: number;
}

export interface StartRunInput {
  episodeId: string;
  model: string;
  twins: TwinName[];
  /** Length of the simulated day, in ticks. */
  ticks: number;
}

export type RunCommand = "pause" | "resume" | "abort";

// ---------------------------------------------------------------------------
// Run panel options. The model list is NOT here: `src/lib/models.ts` is the one
// catalog, shared with Settings and the benchmark table, and a second list would
// be the thing that made two pages spell a model differently.
// ---------------------------------------------------------------------------

/** Day lengths offered by the run panel, at 15 simulated minutes per tick. */
export const DAY_LENGTHS: readonly { ticks: number; label: string; hint: string }[] = [
  { ticks: 12, label: "Short", hint: "3 hours — a morning" },
  { ticks: 24, label: "Half day", hint: "6 hours — 9am to 3pm" },
  { ticks: 36, label: "Full day", hint: "9 hours — the whole workday" },
];
