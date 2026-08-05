import "./env"; // must precede every import that reaches a model module or the db

import path from "node:path";
import { formatEstimate, renderReport, type BenchmarkEvent } from "@sonata/benchmark";
import type { CriterionResult, EpisodeRun, Termination, TwinName } from "@sonata/core";
import { TWIN_NAMES, offsetMinutes, runExecution } from "@sonata/core";
import { reconcileRunRows } from "../../app/api/_lib/mirror";
import { readRun } from "../../app/results/_lib/artifacts";
import { formatSimTime } from "../../app/results/_lib/summary";
import { buildStory, type StoryRow } from "../../app/runs/_lib/story";
import { countEpisodes, countWorlds, listRuns, runStats } from "../lib/db";
import {
  benchDir,
  cancel,
  createWorldFromBrief,
  createWorldFromTemplate,
  judgeSavedRun,
  listScenarios,
  listShipped,
  listTemplates,
  planBench,
  resolveScenario,
  runBench,
  startEpisode,
  status,
  whenDone,
} from "../lib/engine";
import { ago, elapsed, money, percent } from "../lib/format";
import { getApiKeyView, getSettings } from "../lib/settings";
import { TWIN_LABELS, allTwinStatuses, twinUrl } from "../lib/twins";

// The dashboard, without the dashboard.
//
// Every command here calls the SAME function the matching button calls — `sonata
// run` is the Start button, `sonata judge` is the Re-judge button, `sonata bench`
// is the benchmark table. Nothing in this file knows how to run an episode; it
// knows how to print one. That is the rule the CLI lives by, because a terminal
// path that drifted from the product would make the article's numbers untestable
// from the product itself.
//
//   sonata world create "a 12-person fintech, the week before an audit"
//   sonata run "client escalation" --model anthropic/claude-haiku-4.5
//   sonata judge run_lq3f8k_7a2c --model anthropic/claude-sonnet-5
//   sonata bench --dry-run
//   sonata status

const USAGE = `sonata — run agents inside a cloned business

  sonata world create "<description>"   Clone a business and write its first day
  sonata world list                     Cloned businesses and saved scenarios
  sonata world template <id>            Clone the business behind a shipped template

  sonata run <scenario>                 Play a simulated day and score it
                                        (an id or part of a title — see world list)
      --model <slug>                    The model under test (default: Settings)
      --ticks <n>                       Length of the day, in 15-minute ticks
      --twins <a,b>                     Narrow the surfaces attached
      --seed <n>                        Vary the sampling, same day
      --idle-ticks <n>                  Dead intervals that end the day (0 = never)
      --max-minutes <n>                 Wall-clock guard for the whole run
      --max-cost <usd>                  Spend guard for the whole run
      --no-judge                        Skip the judge; keep the checklist
      --judge-model <slug>              Judge with something other than Settings

  sonata judge <runId> [--model <slug>] Re-read a finished day and diagnose it

  sonata bench                          Scenarios x models x seeds, resumable
      --dry-run                         Price the matrix; run nothing
      --models <a,b>  --scenarios <a,b>  --seeds <0,1>
      --budget <usd>  --id <name>       Stop at a spend; name the matrix

  sonata status                         Twins, live runs, and what has been run
  sonata reconcile                      Re-read every artifact and repoint the
                                        runs list at what today's checker says
`;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  words: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const words: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    // A flag followed by a value takes it; a flag followed by another flag, or
    // by nothing, is a switch. `--no-judge` is a switch by name.
    if (next !== undefined && !next.startsWith("--") && !body.startsWith("no-")) {
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true);
    }
  }
  return { words, flags };
}

function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function switchOn(args: Args, name: string): boolean {
  return args.flags.has(name);
}

function list(args: Args, name: string): string[] | undefined {
  const raw = flag(args, name);
  if (!raw) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function number(args: Args, name: string): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} needs a number, not "${raw}"`);
  return n;
}

/**
 * Stop guards from the command line, or undefined to keep the scenario's own.
 *
 * `--idle-ticks 0` is meaningful and must survive: it disables the idle guard,
 * which is how you ask for the whole day from an agent that may go quiet in the
 * middle of it — so this tests for `undefined`, not for falsiness.
 */
function terminationFlags(args: Args): Partial<Termination> | undefined {
  const idle = number(args, "idle-ticks");
  const minutes = number(args, "max-minutes");
  const cost = number(args, "max-cost");
  const out: Partial<Termination> = {
    ...(idle === undefined ? {} : { idleTicks: Math.max(0, Math.round(idle)) }),
    ...(minutes === undefined ? {} : { maxWallClockMs: Math.max(0, minutes) * 60_000 }),
    ...(cost === undefined ? {} : { maxCostUsd: Math.max(0, cost) }),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function twinList(args: Args): TwinName[] | undefined {
  const items = list(args, "twins");
  if (!items) return undefined;
  const twins = items.map((item) => {
    const found = TWIN_NAMES.find((t) => t === item.toLowerCase());
    if (!found) throw new Error(`"${item}" is not a twin. Pick from ${TWIN_NAMES.join(", ")}.`);
    return found;
  });
  return twins;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function say(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The day's own offset. A spec with an offsetless clock cannot run, but a
 *  throw here would lose the run over a formatting detail. */
function safeOffsetMinutes(iso: string): number {
  try {
    return offsetMinutes(iso);
  } catch {
    return 0;
  }
}

/**
 * One line of the day's story, in the same words the run view uses.
 *
 * The tick's timestamp is rendered UTC, so the company's own offset has to come
 * from its clock — otherwise a London world's 09:00 prints as 08:00.
 */
function storyLine(row: StoryRow, offset: number): string {
  const clock = row.firstOfTick ? formatSimTime(row.simTimeISO, offset) : "     ";
  const mark = row.kind === "tool" ? (row.mutation ? "→" : "·") : row.kind === "escalation" ? "!" : " ";
  const where = row.twin ? ` [${row.twin}]` : "";
  const detail = row.description ? ` — ${row.description}` : "";
  return `${clock} ${mark}${where} ${row.title}${detail}`;
}

/** Three states, not two: a criterion nothing could decide is not a failure. */
const CRITERION_MARK = { passed: "PASS", failed: "FAIL", notApplicable: "n/a " } as const;

function checklistLine(c: CriterionResult): string {
  return `  ${CRITERION_MARK[c.status]}  ${c.severity.padEnd(6)} ${c.description}${
    c.evidence ? `\n          ${c.evidence}` : ""
  }`;
}

/** The verdict, read back off the artifact — the same file Results renders. */
function printVerdict(runId: string, fallback: EpisodeRun): void {
  const run = readRun(runId) ?? fallback;
  const verdict = run.verdict;
  say();
  say(`  ${runId}`);
  if (!verdict) {
    // Not "scored zero": there is no score, and the reason is the result.
    say(`  NO RESULT · ${runExecution(run).reason ?? "this run was never scored"}`);
    say("  The artifact is still worth reading — the ticks it did record say why.");
    return;
  }

  say(
    `  ${verdict.outcome.toUpperCase()} · score ${percent(verdict.score)} · autonomy ${percent(
      verdict.autonomy,
    )} · ${money(verdict.cost.usd)} · ${elapsed(run.startedAt, run.endedAt ?? Date.now())}`,
  );

  if (verdict.checklist.length > 0) {
    say();
    say("  What the day asked for");
    for (const c of verdict.checklist) say(checklistLine(c));
  }

  const judge = verdict.judge;
  if (judge) {
    say();
    say("  What the judge found");
    say(`  ${judge.summary}`);
    for (const f of judge.findings) {
      say(`    ${f.severity.padEnd(8)} ${f.mode}${f.tick === undefined ? "" : ` (t${f.tick})`}`);
      if (f.evidence[0]) say(`             ${f.evidence[0]}`);
    }
    for (const f of judge.otherFindings) {
      say(`    ${f.severity.padEnd(8)} ${f.label} (uncatalogued)`);
    }
    if (judge.findings.length === 0 && judge.otherFindings.length === 0) {
      say("    Nothing. It read the day and found no failure mode.");
    }
  }

  say();
  say(`  Artifact: ${path.join(process.cwd(), "data", "runs", `${runId}.json`)}`);
}

// ---------------------------------------------------------------------------
// world
// ---------------------------------------------------------------------------

async function worldCommand(args: Args): Promise<void> {
  const [, action, ...rest] = args.words;

  if (action === "list") {
    const scenarios = listScenarios();
    if (scenarios.length === 0) {
      say("Nothing cloned yet. Run one of the days below, or describe your own business:");
      say('  sonata world create "a 12-person fintech, mid-audit"');
    }
    for (const s of scenarios) {
      say(`${s.id}  ${s.title}`);
      say(`  ${s.worldName} · ${s.twins.join(", ")} · ${s.counts.ticks} ticks · ${ago(s.createdAt)}`);
    }
    say();
    say("The five days that ship with Sonata — run one by id:");
    for (const s of listShipped()) say(`  ${s.id.padEnd(22)} ${s.title}`);
    say();
    say("Templates to clone a business from:");
    for (const t of listTemplates()) say(`  ${t.id.padEnd(22)} ${t.title}`);
    return;
  }

  if (action === "template") {
    const id = rest[0];
    if (!id) throw new Error("Say which template: sonata world template <id>");
    const created = createWorldFromTemplate(id);
    say(`Cloned ${created.world.name}.`);
    say(`  scenario ${created.episode.id} — ${created.episode.title}`);
    say(`  run it:  sonata run ${created.episode.id}`);
    return;
  }

  if (action !== "create") throw new Error(`Unknown world command "${action ?? ""}". ${USAGE}`);

  const brief = rest.join(" ").trim();
  if (!brief) {
    throw new Error('Describe the business: sonata world create "a 12-person fintech, mid-audit"');
  }

  const ticks = number(args, "ticks") ?? getSettings().ticks;
  say(`Cloning "${brief}" …`);
  const created = await createWorldFromBrief(brief, ticks, (line) => say(`  ${line}`));
  const counts = created.world.counts;
  say(`${created.world.name} — ${created.world.description}`);
  say(
    `  ${counts.people} people · ${counts.threads} threads · ${counts.channels} channels · ${counts.events} events`,
  );
  if (created.offline) {
    say("  (assembled from the nearest template — no model answered, so nothing was invented)");
    if (created.offlineReason) say(`  why: ${created.offlineReason}`);
  }
  if (created.backlogReason) {
    say("  (the day was written, but not the weeks behind it — the twins will start empty)");
    say(`  why: ${created.backlogReason}`);
  }
  say(`  scenario ${created.episode.id} — ${created.episode.title}`);
  say(`  run it:  sonata run ${created.episode.id}`);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function runCommand(args: Args): Promise<void> {
  const query = args.words.slice(1).join(" ").trim();
  if (!query) throw new Error("Say which scenario to run: sonata run <scenario>");

  // Resolved here as well as inside `startEpisode` so the terminal can read the
  // day's own clock. Resolving twice costs a lookup and registers nothing twice.
  const episode = resolveScenario(query);
  const offset = safeOffsetMinutes(episode.spec.clock.startISO);
  const termination = terminationFlags(args);

  const view = startEpisode({
    episodeId: episode.id,
    ...(termination ? { termination } : {}),
    ...(flag(args, "model") ? { model: flag(args, "model") as string } : {}),
    ...(number(args, "ticks") === undefined ? {} : { ticks: number(args, "ticks") as number }),
    ...(twinList(args) ? { twins: twinList(args) as TwinName[] } : {}),
    ...(number(args, "seed") === undefined ? {} : { seed: number(args, "seed") as number }),
    ...(switchOn(args, "no-judge") ? { judge: false } : {}),
    ...(switchOn(args, "no-seed") ? { seedWorld: false } : {}),
    ...(flag(args, "judge-model") ? { judgeModel: flag(args, "judge-model") as string } : {}),
    ...(flag(args, "director-model") ? { directorModel: flag(args, "director-model") as string } : {}),
  });

  say(`${view.title}`);
  say(
    `  ${view.model} · ${view.plannedTicks} tick${view.plannedTicks === 1 ? "" : "s"} · run ${view.runId}`,
  );
  say("  Starting the twins and loading the world …");
  say();

  // Ctrl-C stops the day at the next tick boundary rather than orphaning it:
  // the artifact still gets written, and the row stops claiming to be running.
  const stop = () => {
    say("\nStopping at the next tick …");
    cancel(view.runId);
  };
  process.once("SIGINT", stop);

  const done = whenDone(view.runId);
  let since = 0;
  let announcedJudging = false;

  for (;;) {
    const poll = status(view.runId, since);
    if (!poll) break;
    for (const row of buildStory(poll.ticks)) say(storyLine(row, offset));
    since = poll.nextSinceTick;

    if (poll.run.status === "judging" && !announcedJudging) {
      announcedJudging = true;
      say();
      say("  Reading the day back …");
    }
    if (poll.run.status === "done" || poll.run.status === "failed" || poll.run.status === "aborted") {
      if (poll.run.error) say(`\n  ${poll.run.error}`);
      break;
    }
    await sleep(600);
  }

  process.off("SIGINT", stop);
  const run = done ? await done : null;
  if (run) printVerdict(view.runId, run);
  if (run?.status === "failed") process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------

async function judgeCommand(args: Args): Promise<void> {
  const runId = args.words[1];
  if (!runId) throw new Error("Say which run to judge: sonata judge <runId>");

  say(`Judging ${runId} …`);
  const { report, autonomy } = await judgeSavedRun(runId, {
    ...(flag(args, "model") ? { model: flag(args, "model") as string } : {}),
  });
  say(`  ${report.model} · autonomy ${percent(autonomy)}`);
  say();
  say(`  ${report.summary}`);
  for (const f of report.findings) {
    say(`    ${f.severity.padEnd(8)} ${f.mode}${f.tick === undefined ? "" : ` (t${f.tick})`}`);
    if (f.evidence[0]) say(`             ${f.evidence[0]}`);
  }
  if (report.findings.length === 0) say("    No catalogued failure mode fired.");
}

// ---------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------

function benchEventLine(event: BenchmarkEvent): string {
  switch (event.kind) {
    case "resumed":
      return `  · ${event.cell.runId} — already on disk (${percent(event.result.score)})`;
    case "cell-start":
      return `  ▸ ${event.cell.model} on ${event.cell.scenarioId} (seed ${event.cell.seed}) — ${
        event.done + 1
      }/${event.total}`;
    case "cell-done":
      return `    ${event.result.outcome ?? "no result"} · score ${percent(
        event.result.score,
      )} · autonomy ${percent(event.result.autonomy)} · ${money(event.result.cost.usd)}`;
    case "cell-failed":
      return `    failed: ${event.error}`;
    case "stopped":
      return `  Stopped (${event.reason}) after ${money(event.spentUsd)}.`;
  }
}

async function benchCommand(args: Args): Promise<void> {
  const opts = {
    ...(flag(args, "id") ? { id: flag(args, "id") as string } : {}),
    ...(list(args, "scenarios") ? { scenarios: list(args, "scenarios") as string[] } : {}),
    ...(list(args, "models") ? { models: list(args, "models") as string[] } : {}),
    ...(list(args, "seeds") ? { seeds: (list(args, "seeds") as string[]).map(Number) } : {}),
    ...(number(args, "budget") === undefined ? {} : { budgetUsd: number(args, "budget") as number }),
    ...(switchOn(args, "no-judge") ? { judge: false } : {}),
  };

  const { plan, estimate, titles } = planBench(opts);
  say(`Benchmark "${plan.matrix.id}" — ${plan.cells.length} cells`);
  say(
    `  ${plan.matrix.scenarioIds.length} scenarios x ${plan.matrix.models.length} models x ${plan.matrix.seeds.length} seeds`,
  );
  for (const id of plan.matrix.scenarioIds) say(`    ${id}  ${titles[id] ?? ""}`);
  say();
  say(formatEstimate(estimate));
  say();
  if (plan.done.length > 0) {
    say(`  ${plan.done.length} cells are already on disk and will be reused.`);
  }
  say(`  Artifacts: ${benchDir()}`);

  if (switchOn(args, "dry-run")) {
    say();
    say("Dry run — nothing was run. Drop --dry-run to start.");
    return;
  }
  if (plan.pending.length === 0) {
    say();
    say("Every cell is already on disk. Nothing to run.");
    return;
  }

  const controller = new AbortController();
  const stop = () => {
    say("\nFinishing the current cell, then stopping …");
    controller.abort();
  };
  process.once("SIGINT", stop);

  say();
  const report = await runBench({
    ...opts,
    signal: controller.signal,
    onEvent: (event) => say(benchEventLine(event)),
  });
  process.off("SIGINT", stop);

  say();
  say(renderReport(report.aggregate));
  if (report.stopped) {
    say(`Stopped early (${report.stopped.reason}). Run sonata bench again to pick up where it left off.`);
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function statusCommand(): Promise<void> {
  const settings = getSettings();
  const key = getApiKeyView();

  say("Twins");
  for (const twin of await allTwinStatuses(true)) {
    say(
      `  ${twin.ok ? "up  " : "down"} ${TWIN_LABELS[twin.twin].padEnd(9)} ${twinUrl(twin.twin).padEnd(
        22,
      )} ${twin.detail}`,
    );
  }

  say();
  say("Models");
  say(`  agent    ${settings.models.agent}`);
  say(`  director ${settings.models.director}`);
  say(`  judge    ${settings.models.judge}`);
  say(
    `  key      ${key.source === "none" ? "not set — no model can be reached" : `${key.masked} (${key.source})`}`,
  );

  const stats = runStats();
  say();
  say("Work");
  say(
    `  ${countWorlds()} businesses · ${countEpisodes()} scenarios · ${stats.scored} scored runs` +
      // Named, never averaged in: a run that never executed has no performance.
      (stats.unscored > 0 ? ` · ${stats.unscored} that never ran` : ""),
  );
  if (stats.scored > 0) {
    say(
      `  pass rate ${percent(stats.passRate)} · autonomy ${percent(stats.autonomy)} · spent ${money(
        stats.spendUsd,
      )}`,
    );
  }

  const recent = listRuns({ limit: 8 });
  if (recent.length === 0) {
    say();
    say('  Nothing has run yet. Try: sonata world create "a 12-person fintech, mid-audit"');
    return;
  }
  say();
  say("Recent runs");
  for (const run of recent) {
    const progress =
      run.status === "running" || run.status === "judging"
        ? `${run.tick}/${run.totalTicks} ticks`
        : `${percent(run.score)} · ${percent(run.autonomy)} autonomy`;
    say(`  ${run.status.padEnd(8)} ${run.id.padEnd(22)} ${run.episodeTitle}`);
    say(`           ${run.model} · ${progress} · ${ago(run.startedAt)}`);
  }
}

/**
 * Repoint the runs list at the artifacts.
 *
 * The relational row caches a verdict so a list renders without parsing the
 * whole day, and a cache written by an older checker is how Home and a run's own
 * page came to print two different numbers for one run. Run this after anything
 * that changes what a criterion means.
 */
function reconcileCommand(): void {
  const moved = reconcileRunRows();
  if (moved.length === 0) {
    say("Every run already reads the same in the list as it does on its own page.");
    return;
  }
  say(`Repointed ${moved.length} run${moved.length === 1 ? "" : "s"} at today's checker:`);
  for (const m of moved) {
    say(
      `  ${m.runId.padEnd(22)} score ${percent(m.was.score)} → ${percent(m.now.score)}` +
        ` · autonomy ${percent(m.was.autonomy)} → ${percent(m.now.autonomy)}`,
    );
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.words[0];

  switch (command) {
    case "world":
      return worldCommand(args);
    case "run":
      return runCommand(args);
    case "judge":
      return judgeCommand(args);
    case "bench":
      return benchCommand(args);
    case "status":
      return statusCommand();
    case "reconcile":
      return reconcileCommand();
    case undefined:
    case "help":
      say(USAGE);
      return;
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
