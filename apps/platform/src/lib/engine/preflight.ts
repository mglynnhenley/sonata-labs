import type { TwinName } from "@sonata/core";
import { injectWorld, type GeneratedWorld } from "@sonata/world";
import { TWIN_LABELS, startTwin, twinLogTail, twinStatus, twinUrl } from "../twins";

// Getting the world ready before tick 0.
//
// A run cannot begin until every surface it touches is answering, and the one
// thing a first-time user must never have to do is open a terminal — so a twin
// that is not up gets started here rather than reported as an error. What is
// still an error is a twin that will not come up: the run fails before it has
// spent a penny, and the message says which surface and what it printed on its
// way down.

/** A cold Next app compiles its routes on first request; that is most of this. */
const READY_TIMEOUT_MS = 90_000;
const POLL_MS = 800;

export interface PreflightResult {
  twin: TwinName;
  url: string;
  detail: string;
  /** True when this call is what started it. */
  started: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ready(twin: TwinName, deadline: number): Promise<string> {
  for (;;) {
    const status = await twinStatus(twin, true);
    if (status.ok) return status.detail;
    if (Date.now() >= deadline) {
      const log = twinLogTail(twin, 12).trim();
      throw new Error(
        `The ${TWIN_LABELS[twin]} twin never came up on ${twinUrl(twin)} (${status.detail}).` +
          (log ? `\nIts last output was:\n${log}` : ""),
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * Every twin the episode needs, up and answering.
 *
 * Sequential rather than parallel: three `next dev` servers compiling at once on
 * a laptop is how the first run of the day takes four minutes and looks broken.
 */
export async function ensureTwins(twins: readonly TwinName[]): Promise<PreflightResult[]> {
  const out: PreflightResult[] = [];
  for (const twin of twins) {
    const current = await twinStatus(twin, true);
    if (current.ok) {
      out.push({ twin, url: twinUrl(twin), detail: current.detail, started: false });
      continue;
    }
    await startTwin(twin);
    const detail = await ready(twin, Date.now() + READY_TIMEOUT_MS);
    out.push({ twin, url: twinUrl(twin), detail, started: true });
  }
  return out;
}

/** Where each twin lives, in the shape the engine's adapters take. */
export function twinUrlMap(twins: readonly TwinName[]): Partial<Record<TwinName, string>> {
  const urls: Partial<Record<TwinName, string>> = {};
  for (const twin of twins) urls[twin] = twinUrl(twin);
  return urls;
}

/**
 * Load the cloned business — the whole backlog, not just the cast — into the
 * twins, and make it the state a reset returns to.
 *
 * This is what the engine's own cast-only seeding cannot do: an `EpisodeSpec`
 * carries a cast and a day, never a history, so seeding from it leaves the agent
 * opening an empty inbox in a company that is supposed to have been running for
 * weeks. `injectWorld` posts the resolved wire seed the twins document, with
 * every id, address and timestamp already fixed, so all three surfaces get the
 * same people.
 *
 * Throws on a twin that would not take it: a run against a half-loaded company
 * scores the agent for the seeder's mistake.
 */
export async function loadClone(
  clone: GeneratedWorld,
  twins: readonly TwinName[],
  say: (msg: string) => void = () => {},
): Promise<Record<string, number>> {
  const report = await injectWorld(clone, {
    twins: [...twins],
    baseUrls: twinUrlMap(twins),
    promoteToSnapshot: true,
    say,
  });
  if (!report.ok) {
    const bad = report.results.filter((r) => !r.ok);
    throw new Error(
      `the cloned business could not be loaded into ${bad.map((r) => r.twin).join(" and ")}: ` +
        bad.map((r) => `${r.twin} said ${r.error ?? `HTTP ${r.status}`}`).join("; "),
    );
  }
  const counts: Record<string, number> = {};
  for (const r of report.results) {
    for (const [what, n] of Object.entries(r.counts ?? {})) counts[`${r.twin}.${what}`] = n;
  }
  return counts;
}
