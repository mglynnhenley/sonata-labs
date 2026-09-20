import { runExecution, runTruncation, type EpisodeRun, type EpisodeSpec, type TwinName } from "@sonata/core";
// Its own labels, as `report.ts` next door also keeps. The design system's are
// JSX-adjacent and `src/lib/twins` can start a twin process; a derivation that
// only needs nine nouns should drag in neither.
const LABEL: Record<TwinName, string> = {
  gmail: "Gmail",
  slack: "Slack",
  calendar: "Calendar",
  attio: "Attio",
  "google-docs": "Google Docs",
  "google-ads": "Google Ads",
  linkedin: "LinkedIn",
  excel: "Excel",
  desk: "the desk",
};

// WHAT KIND OF DAY THIS WAS, WITHOUT KNOWING THE JOB.
//
// Everything else on a report is written in the scenario's own vocabulary. The
// judge's account of a tax day says "CRS GBP 11 / 70000" and "CRS-DEC-05-v1 for
// 00105/ENT-01"; a continuity week's marks are "EO02 allocation-fulfilment: U".
// Both are precise and neither tells a reader who does not already do that job
// whether the run went well.
//
// Worse, the shape of a day is easy to misread from that prose. One real report
// opened with five sentences beginning "Never sent", "Never prepared", "Never
// updated" — an agent that looked useless, on a day we cut off at three
// intervals of four, before any of it could have arrived.
//
// So this is the orientation layer: counts anyone can read, and one sentence
// naming the shape. It calls nothing a success or a failure, because that is the
// checklist's job and the domain's. It answers "how far did this get, how much
// did it do, and could any of it be marked" — which is what a reader needs
// before the domain prose is safe to read.
//
// Derived from the artifact, never from a model. A sentence here must be true of
// a run nobody has judged.

export interface ShapeFact {
  label: string;
  value: string;
  /** Worth a reader's eye — an incomplete day, nothing gradeable. */
  flag?: boolean;
}

export interface DayShape {
  /** One sentence, no domain terms and no verdict. */
  headline: string;
  facts: ShapeFact[];
  /**
   * Whose doing the shape was. `harness` means the day itself was short or
   * broken, so what the agent did not do was mostly not available to it.
   * `unknown` when the artifact cannot tell — never guessed.
   */
  cause: "agent" | "harness" | "unknown";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Excel", "Gmail and Slack", "Gmail, Slack and Calendar". */
function listSurfaces(twins: TwinName[]): string {
  const names = twins.map((twin) => LABEL[twin]);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function dayShape(run: EpisodeRun, spec?: EpisodeSpec | null): DayShape {
  const execution = runExecution(run);
  const truncation = spec ? runTruncation(run, spec) : null;
  const observed = truncation?.executedTicks ?? run.ticks.length;
  // Null, not `observed`, when no spec was supplied. Defaulting the planned
  // length to the observed one would report every truncated day as a complete
  // one — the precise misreading this exists to prevent, and it did exactly that
  // in the exported report while the page beside it said the day was cut short.
  const planned = truncation?.scheduledTicks ?? null;
  const short = planned !== null && planned > 0 && observed < planned;

  const steps = run.ticks.flatMap((tick) => tick.agentSteps);
  const changes = steps.flatMap((step) => (step.kind === "tool" && step.isMutation ? [step] : []));
  const touched = [...new Set(changes.map((step) => step.twin).filter((twin): twin is TwinName => Boolean(twin)))];
  const silent = run.ticks.filter((tick) => tick.agentSteps.length === 0).length;

  // What could be marked at all. A checklist row that is `notApplicable` was not
  // failed — nothing was gradeable — and a reader who reads 0% as "got nothing
  // right" has been misled by the denominator.
  const checklist = run.verdict?.checklist ?? [];
  const measured = checklist.filter((row) => row.status === "passed" || row.status === "failed").length;
  // A continuity week publishes its own marks instead; U is its unmeasured.
  const units = (run.benchmark?.criteria ?? []).flatMap((criterion) => criterion.units);
  const markedUnits = units.filter((unit) => unit.score !== "U" && unit.score !== "N/A").length;

  const facts: ShapeFact[] = [
    {
      label: "How far it got",
      value: planned !== null && planned > 0
        ? `${observed} of ${plural(planned, "interval")}`
        : `${plural(observed, "interval")} recorded`,
      flag: short,
    },
    {
      label: "What it changed",
      value: changes.length === 0
        ? "nothing"
        : `${plural(changes.length, "change")}${touched.length ? `, in ${listSurfaces(touched)}` : ""}`,
      flag: changes.length === 0,
    },
    { label: "Intervals with no action", value: `${silent} of ${observed || 0}`, flag: silent > 0 && silent === observed },
  ];

  if (units.length > 0) {
    facts.push({
      label: "Marks the week could give",
      value: `${markedUnits} of ${units.length}`,
      flag: markedUnits === 0,
    });
  } else if (checklist.length > 0) {
    facts.push({
      label: "Requirements that could be judged",
      value: `${measured} of ${checklist.length}`,
      flag: measured === 0,
    });
  }

  // `runExecution` already decides whether a run may carry a score, and says why
  // in the words a page should print. Deferring to it keeps this from becoming a
  // second, quietly disagreeing opinion about the same artifact.
  //
  // But "there is no result" and "this was not the agent's doing" are different
  // claims, and only some of its reasons are ours. An agent that never touched a
  // twin had its whole day and spent it doing nothing; saying that was not
  // available to it would excuse the one failure most worth seeing.
  const idle = execution.toolCalls === 0 && execution.ticks > 0;
  const cause: DayShape["cause"] =
    idle ? "agent"
    : execution.reason || short ? "harness"
    : execution.executed ? "agent"
    : "unknown";

  return {
    headline: headlineFor({ short, observed, planned, idle, changes: changes.length, execution, measured, units: units.length, markedUnits }),
    facts,
    cause,
  };
}

function headlineFor(input: {
  short: boolean;
  observed: number;
  planned: number | null;
  idle: boolean;
  changes: number;
  execution: ReturnType<typeof runExecution>;
  measured: number;
  units: number;
  markedUnits: number;
}): string {
  const { short, observed, planned, idle, changes, execution } = input;
  const gradeable = input.units > 0 ? input.markedUnits : input.measured;

  // An idle day is read first and plainly. It is the one shape where a short day
  // is not the explanation, and the one a reader most needs told straight.
  if (idle) {
    return `The agent had ${plural(observed, "interval")} and used none of them: it never touched an app. Nothing here was cut short on our side.`;
  }
  // Otherwise the reasons a day cannot be read come before anything about the
  // agent, because they change what the rest of the page means.
  if (execution.reason) {
    return `${execution.reason} What the agent did not do was largely not available to it.`;
  }
  if (short && planned !== null) {
    return `The day stopped after ${observed} of ${plural(planned, "interval")}, so most of what the scenario had planned never reached the agent. Anything it "never did" may simply never have arrived.`;
  }
  const ran = input.planned === null ? `The day recorded ${plural(observed, "interval")}` : "The day ran to the end";
  if (changes === 0) {
    return `${ran} and the agent changed nothing in any app. Whatever it may have read or reasoned, it left the world exactly as it found it.`;
  }
  if (gradeable === 0) {
    return `${ran} and the agent made ${plural(changes, "change")}, but nothing on the scorecard could be measured against it. There is work here and no mark for it.`;
  }
  return `${ran}. The agent made ${plural(changes, "change")}, and ${gradeable} of the scorecard's requirements could be judged against what it did.`;
}
