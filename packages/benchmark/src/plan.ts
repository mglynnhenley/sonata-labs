// The matrix. Scenarios x models x seeds, expanded into an ordered list of cells
// with one stable id each — and that id is the whole trick behind resuming.
//
// A full benchmark is hours of billable model calls, so it WILL be interrupted:
// a laptop sleeps, a provider 500s, someone hits ctrl-C to look at a result. The
// planner therefore never derives a cell id from a clock or a counter. Given the
// same matrix it produces the same ids forever, so "already on disk" is a
// question that can be asked of a plan rather than remembered by a process.

/** The matrix as authored. */
export interface BenchmarkMatrix {
  /**
   * Stable id for this matrix. It prefixes every cell id and names the aggregate
   * artifact, so two matrices can share one runs directory without collision.
   */
  id: string;
  /** `EpisodeSpec.id` values, in the order they should appear as table columns. */
  scenarioIds: string[];
  /** OpenRouter slugs of the models under test — the table's rows. */
  models: string[];
  /**
   * Seeds. Same spec, same model, different sampling in the world generator and
   * the director. Running more than one is what turns a single number into a
   * number with an error bar, and the article needs the error bar.
   */
  seeds: number[];
}

/** One episode to run: this scenario, on this model, with this seed. */
export interface Cell {
  /** Deterministic, filename-safe, and the resume key. Treat it as opaque. */
  runId: string;
  scenarioId: string;
  model: string;
  seed: number;
  /** 0-based position in execution order. */
  index: number;
}

export interface BenchmarkPlan {
  matrix: BenchmarkMatrix;
  /** Every cell, in execution order. */
  cells: Cell[];
  /** The cells still to run — what the runner iterates. */
  pending: Cell[];
  /** Cells whose artifact was already on disk, skipped by this session. */
  done: Cell[];
}

/**
 * Filename-safe form of an arbitrary id. The result matches @sonata/judge's
 * `SAFE_RUN_ID` (`/^[\w.-]+$/`), so a benchmark run's judge artifact can sit
 * beside it under the same base name.
 */
export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // An id made entirely of separators would collapse to "", and an empty path
  // component turns "a--s0" into something that silently aliases another cell.
  return out === "" ? "x" : out;
}

/**
 * The run id for one cell. Deterministic in its four inputs and nothing else —
 * no timestamp, no counter — which is the property resume rests on.
 */
export function cellRunId(
  benchmarkId: string,
  scenarioId: string,
  model: string,
  seed: number,
): string {
  return [slug(benchmarkId), slug(scenarioId), slug(model), `s${seed}`].join("--");
}

/** Cells in the matrix, before any resume filtering. */
export function matrixSize(matrix: BenchmarkMatrix): number {
  return matrix.scenarioIds.length * matrix.models.length * matrix.seeds.length;
}

function assertUnique(label: string, xs: Array<string | number>): void {
  const seen = new Set<string | number>();
  for (const x of xs) {
    if (seen.has(x)) throw new Error(`Duplicate ${label} in matrix: ${String(x)}`);
    seen.add(x);
  }
}

function assertNonEmpty(label: string, xs: unknown[]): void {
  if (xs.length === 0) throw new Error(`Matrix has no ${label}`);
}

/**
 * Expand a matrix into an ordered plan, minus anything already finished.
 *
 * Order is seed-outermost, then scenario, then model. That is deliberate and it
 * is not the obvious nesting: it means seed 0 of the ENTIRE table finishes before
 * seed 1 starts, so an interrupted benchmark still renders a complete table with
 * one seed per cell rather than three seeds of the first two scenarios and blanks
 * everywhere else.
 *
 * `existing` is the set of run ids already on disk (see `listRunIds` in ./store).
 * It is passed in rather than read here so the planner stays pure — the same
 * function decides what to run in a test, in a dry-run and in the real thing.
 *
 * Throws on a matrix that would overwrite its own artifacts: an empty axis, a
 * duplicated entry, or two entries whose slugs collide. Silently running 8 cells
 * when 9 were asked for is the kind of bug that is only noticed in the table.
 */
export function planMatrix(
  matrix: BenchmarkMatrix,
  existing: Iterable<string> = [],
): BenchmarkPlan {
  assertNonEmpty("scenarios", matrix.scenarioIds);
  assertNonEmpty("models", matrix.models);
  assertNonEmpty("seeds", matrix.seeds);
  assertUnique("scenario", matrix.scenarioIds);
  assertUnique("model", matrix.models);
  assertUnique("seed", matrix.seeds);

  const cells: Cell[] = [];
  const ids = new Set<string>();
  let index = 0;

  for (const seed of matrix.seeds) {
    for (const scenarioId of matrix.scenarioIds) {
      for (const model of matrix.models) {
        const runId = cellRunId(matrix.id, scenarioId, model, seed);
        if (ids.has(runId)) {
          throw new Error(
            `Cell id collision on "${runId}" (${scenarioId} / ${model} / seed ${seed}) — ` +
              `two entries slug to the same name and would share one artifact`,
          );
        }
        ids.add(runId);
        cells.push({ runId, scenarioId, model, seed, index: index++ });
      }
    }
  }

  const have = new Set(existing);
  return {
    matrix,
    cells,
    pending: cells.filter((c) => !have.has(c.runId)),
    done: cells.filter((c) => have.has(c.runId)),
  };
}
