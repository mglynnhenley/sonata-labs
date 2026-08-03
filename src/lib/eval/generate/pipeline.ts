import { performance } from "node:perf_hooks";
import type { gmail_v1 } from "googleapis";
import { pickStyleExemplars } from "../context";
import { bindContact } from "../generate";
import type {
  Anchor,
  Contact,
  Exemplar,
  Fixture,
  GenerationTrace,
  MailboxProfile,
  StressScenario,
} from "../types";
import { composeStage, type Composed, type ComposeInput } from "./compose";
import { comprehendStage } from "./comprehend";
import { optionsStage, type OptionsInput, type OptionsResult } from "./options";
import { FALLBACK_PREFIX, rankStage } from "./rank";
import { recallStage } from "./recall";
import {
  humanPhrase,
  NO_ANCHOR_PHRASE,
  timelineStage,
  type TimelineInput,
} from "./timeline";
import type {
  Approach,
  Candidate,
  Ranked,
  Stage,
  StageCtx,
  ThreadContext,
  Timeline,
} from "./types";

// ---------------------------------------------------------------------------
// The driver. It owns three things the stages deliberately do not: the clock, the
// wiring, and the record of what happened.
//
// The clock, because `now` is the input every date in a fixture is derived from —
// one read here means a test that pins it pins the whole fixture, and a stage that
// reached for `Date.now()` itself would silently escape that.
//
// The record, because a weak probe is otherwise unattributable. Every stage's
// output goes onto `GenerationTrace` whole, along with whether that stage got what
// it wanted or degraded — a fixture alone never shows whether the anchor was badly
// ranked or the prose was badly written.
//
// And the wiring, because no stage may fail the run on its own. Each one below is
// paired with a declared fallback, so a thin mailbox, a dropped model call or an
// outright broken stage costs the probe some strength and says so, rather than
// costing the run.
// ---------------------------------------------------------------------------

type StageName =
  | "recall"
  | "rank"
  | "comprehend"
  | "timeline"
  | "options"
  | "compose";

export interface PipelineOptions {
  /** Per-stage model override — a cheap model ranks fine, composing needs the best. */
  models?: { rank?: string; comprehend?: string; options?: string; compose?: string };
  /** Injected wall clock. Omit outside tests; the pipeline reads the clock once. */
  now?: number;
  /**
   * Swap any stage for a stub. Values are `unknown` rather than `Stage<any, any>`
   * because each stage has a different In/Out pair and a shared map type would
   * either force `any` through the public contract or need six separate fields;
   * the driver knows the pair per key and re-asserts it at the point of use.
   */
  stages?: Partial<Record<StageName, unknown>>;
  /** Progress line, wired to the CLI's `--explain` / `onProgress`. */
  say?(msg: string): void;
  /** Few-shot style exemplars pulled from the real mailbox for stage 6. */
  exemplarCount?: number;
}

/**
 * Prefix-free phrasings of degradation. `FALLBACK_PREFIX` is the contract a stage
 * declares against; this catches stages that report the same thing mid-sentence,
 * because a degradation that never reaches the artifact is one nobody will ever
 * diagnose from a saved run.
 */
const FALLBACK_PHRASE = /\bfell back\b|\bfalling back\b|\bfallback\b/i;

function fallbackNote(lines: string[]): string | undefined {
  const declared = lines.find((l) => l.startsWith(FALLBACK_PREFIX));
  if (declared) return declared.slice(FALLBACK_PREFIX.length);
  return lines.find((l) => FALLBACK_PHRASE.test(l));
}

/** Re-assert the In/Out pair an injected stub is standing in for. */
function stageOr<In, Out>(override: unknown, real: Stage<In, Out>): Stage<In, Out> {
  return (override as Stage<In, Out> | undefined) ?? real;
}

/**
 * Highest score, ties keeping list order — the same reduce stage 3 uses to choose
 * which thread to read in full. The two have to agree: the anchor this run reports
 * must be the thread the probe was actually written about.
 */
function pickWinner(ranked: Ranked[]): Ranked | null {
  return ranked.reduce<Ranked | null>(
    (best, r) => (best === null || r.score > best.score ? r : best),
    null,
  );
}

function toAnchor(c: Candidate): Anchor {
  return {
    threadId: c.threadId,
    lastMessageId: c.lastMessageId,
    subject: c.subject,
    fromAddr: c.fromAddr,
    fromName: c.fromName,
    bodyExcerpt: c.bodyExcerpt,
    internalDate: c.internalDate,
    messageCount: c.messageCount,
  };
}

/**
 * Fallback for a rank stage that threw: newest first, which is exactly what
 * `findAnchorThread` did before ranking existed. Scores descend with position so a
 * reader that re-sorts the trace still sees the order the pick was made in.
 */
function byRecency(candidates: Candidate[]): Ranked[] {
  return [...candidates]
    .sort((a, b) => b.internalDate - a.internalDate || a.threadId.localeCompare(b.threadId))
    .map((candidate, i) => ({
      candidate,
      score: -i,
      reasons: ["ranking failed — most recent thread wins, as it did before ranking existed"],
    }));
}

/**
 * Fallback for a comprehend stage that threw outright. Stage 3 already handles a
 * failed model call itself, so reaching this means the stage broke — describe the
 * winner from what stage 1 hydrated, and say plainly what is unknown so stages 5
 * and 6 cannot quote a guess as fact.
 */
function unreadThread(winner: Ranked | null, now: number): ThreadContext {
  if (!winner) {
    const none = "No thread in this mailbox qualified as an anchor.";
    return {
      threadId: "",
      summary: none,
      leftOffAt: none,
      owes: none,
      openQuestions: [],
      tone: none,
    };
  }

  const c = winner.candidate;
  const unknown = "Not known — the thread could not be read.";
  return {
    threadId: c.threadId,
    summary:
      `Thread "${c.subject}" with ${c.fromName} <${c.fromAddr}>, ${c.messageCount} message(s). ` +
      `Its most recent message reads: ${c.bodyExcerpt}`,
    leftOffAt:
      `${c.fromName} wrote ${humanPhrase(c.internalDate, now)}; the owner ` +
      `${c.ownerReplied ? "has replied on this thread" : "never replied"}.`,
    owes: c.ownerReplied ? unknown : `The owner owes ${c.fromName} a reply.`,
    openQuestions: [],
    tone: unknown,
  };
}

/** Fallback for an options stage that threw: stage on the thread's own open state. */
function unconsidered(scenario: StressScenario, thread: ThreadContext): OptionsResult {
  const approach: Approach = {
    id: "left-off",
    angle: `${scenario.title}, arising directly from where this thread stopped: ${thread.leftOffAt}`,
    rationale: "No angle was proposed — derived in code from the thread's own open state.",
    plausibility: 0.5,
  };
  return { approaches: [approach], chosen: approach };
}

/**
 * An empty timeline. Stage 6 dates any slot the timeline doesn't cover from the
 * scenario's own `minutesAgo`, i.e. the unanchored behaviour that predates stage 4 —
 * so an empty one degrades the fixture's dates rather than losing the fixture.
 */
function noTimeline(): Timeline {
  return { anchorLastAt: 0, anchorPhrase: NO_ANCHOR_PHRASE, slots: [] };
}

/**
 * Build one fixture: find the mailbox's usable history, pick the thread this
 * scenario can honestly be staged on, read it, date everything against it, choose an
 * angle, and write the prose.
 *
 * Returns the anchor as well as the fixture because the anchor is what the report's
 * `anchoredToRealThread` and the grader's thread-level assertions are stated in
 * terms of — it is a result of the run, not an input to it.
 */
export async function runPipeline(args: {
  gmail: gmail_v1.Gmail;
  userId: string;
  scenario: StressScenario;
  profile: MailboxProfile;
  options?: PipelineOptions;
}): Promise<{
  fixture: Fixture;
  contact: Contact;
  anchor: Anchor | null;
  trace: GenerationTrace;
}> {
  const { gmail, userId, scenario, profile } = args;
  const opts = args.options ?? {};
  const models = opts.models ?? {};
  const trace: GenerationTrace = { stages: [] };

  // Progress lines are tapped as well as forwarded. A stage announces its own
  // degradation on this channel and nowhere else, and that has to survive into the
  // artifact — on a terminal nobody was watching it is lost.
  let lines: string[] = [];
  const say = (msg: string) => {
    lines.push(msg);
    opts.say?.(msg);
  };

  const ctx: StageCtx = {
    gmail,
    userId,
    scenario,
    profile,
    // The one clock read in the entire generator.
    now: opts.now ?? Date.now(),
    // Stage names are the model-override keys, so no mapping table can drift.
    model: (stage) => models[stage as keyof typeof models],
    say,
  };

  /**
   * Run one stage, time it, and put whatever it produced on the trace. Omitting
   * `fallback` declares that this stage has nothing to degrade to.
   */
  async function runStage<In, Out>(
    stage: Stage<In, Out>,
    input: In,
    fallback?: (err: Error) => Out,
  ): Promise<Out> {
    lines = [];
    // Monotonic, not `ctx.now`: a pinned clock would report every stage as 0ms, and
    // a wall clock that steps mid-run can report a negative duration.
    const startedAt = performance.now();
    const record = (output: unknown, fellBack?: string) => {
      trace.stages.push({
        name: stage.name,
        durationMs: Math.round(performance.now() - startedAt),
        output,
        ...(fellBack ? { fellBack } : {}),
      });
    };

    try {
      const output = await stage.run(input, ctx);
      record(output, fallbackNote(lines));
      return output;
    } catch (err) {
      const message = (err as Error).message;
      if (!fallback) {
        // Record before rethrowing: the caller still wants to see how far the run
        // got and which stage stopped it.
        record(undefined, `stage failed (${message})`);
        throw err;
      }
      say(`${stage.name}: ${message} — falling back`);
      const output = fallback(err as Error);
      record(output, `stage threw (${message})`);
      return output;
    }
  }

  const recall = stageOr<void, Candidate[]>(opts.stages?.recall, recallStage);
  const rank = stageOr<Candidate[], Ranked[]>(opts.stages?.rank, rankStage);
  const comprehend = stageOr<Ranked[], ThreadContext>(
    opts.stages?.comprehend,
    comprehendStage,
  );
  const timeline = stageOr<TimelineInput, Timeline>(opts.stages?.timeline, timelineStage);
  const options = stageOr<OptionsInput, OptionsResult>(opts.stages?.options, optionsStage());
  const compose = stageOr<ComposeInput, Composed>(opts.stages?.compose, composeStage);

  // 1-2. Only scenarios that want real history under them pay for the search. Half
  // the catalog doesn't (`preferAnchor: false`), and skipping costs those nothing:
  // stage 3 owns the "no candidate" context and makes no model call to produce it.
  const candidates = scenario.preferAnchor
    ? await runStage(recall, undefined as void, () => [])
    : [];
  const ranked = scenario.preferAnchor
    ? await runStage(rank, candidates, () => byRecency(candidates))
    : [];

  const winner = pickWinner(ranked);
  const anchor = winner ? toAnchor(winner.candidate) : null;
  if (anchor) {
    say(`anchoring to real thread "${anchor.subject}" from ${anchor.fromName}`);
  } else if (scenario.preferAnchor) {
    say("no usable anchor thread — the scenario runs on invented history alone");
  }

  // 3. Read the winner in full. Runs even unanchored, where it is the constructor
  // for the "nothing qualified" context stage 5 still needs.
  const thread = await runStage(comprehend, ranked, () => unreadThread(winner, ctx.now));

  // 4. Absolute times for every slot, rebased off the anchor's real last message.
  const times = await runStage(
    timeline,
    { anchorLastAt: anchor?.internalDate ?? null },
    () => noTimeline(),
  );

  // Stage 6 re-binds this from the same inputs; binding here too is what lets stage
  // 5 name the sender, and lets the exemplar search prefer that person's own mail.
  const contact = bindContact(scenario, profile, anchor);

  let exemplars: Exemplar[] = [];
  try {
    exemplars = await pickStyleExemplars(gmail, userId, {
      fromEmail: contact.email,
      count: opts.exemplarCount ?? 3,
    });
  } catch (err) {
    // Style exemplars make the prose sound like the mailbox; without them it is
    // merely generic, which is not worth losing a run over.
    say(`exemplars unavailable (${(err as Error).message}) — composing without them`);
  }

  // 5. Weigh angles, then commit to one.
  const approaches = await runStage(options, { thread, contact }, () =>
    unconsidered(scenario, thread),
  );

  // 6. Write it. No fallback: a pipeline that returns no fixture has not degraded,
  // it has failed, and the caller needs to hear that rather than inject nothing.
  const composed = await runStage(compose, {
    anchor,
    // An empty threadId is stage 3's signal that it read nothing real; stage 6
    // then quotes the raw excerpt instead of a summary of a thread nobody read.
    thread: thread.threadId ? thread : null,
    timeline: times,
    approach: approaches.chosen,
    exemplars,
  });

  return { fixture: composed.fixture, contact: composed.contact, anchor, trace };
}
