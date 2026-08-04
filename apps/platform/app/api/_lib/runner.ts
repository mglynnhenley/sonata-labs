import {
  autonomyScore,
  checklistScore,
  resolvePerson,
  tickToISO,
  verdictOutcome,
  type AgentStep,
  type Beat,
  type BeatFired,
  type Criterion,
  type CriterionResult,
  type DirectorEvent,
  type EpisodeRun,
  type EpisodeSpec,
  type TickRecord,
  type TwinName,
} from "@sonata/core";
// The timeline projection is shared on purpose: the one line the overview card
// shows must be the same sentence the run timeline shows for that moment.
import { lastEventLine } from "../../runs/_lib/story";
import { mirrorRunFinish, mirrorRunProgress, mirrorRunStart } from "./mirror";
import { getEpisode } from "./records";
import { getDoc, listDocs, newId, putDoc } from "./store";
import { TWIN_URLS } from "./twins";
import type { RunDetail, RunSummary, StartRunInput } from "./types";

// The run lifecycle the dashboard talks to: start, poll, pause, resume, abort,
// finish with a score. Runs advance on a wall-clock timer, one simulated tick at
// a time, and every tick is written to disk as it completes — so the polling
// endpoint is a plain read and a browser refresh mid-run loses nothing.
//
// `advanceTick` below is a STAND-IN. It plays the scripted beats on schedule,
// improvises the world's answers and records what an agent would have done, so
// the whole surface around it — persistence, the poll contract, pause/abort,
// scoring off the checklist — is real and exercised. When the episode engine
// lands, it replaces the body of `advanceTick` and nothing else in this file or
// in the dashboard changes.

/** Wall-clock milliseconds per simulated tick. */
const MS_PER_TICK = Number(process.env.SONATA_MS_PER_TICK ?? 1400);

interface PendingReply {
  fireTick: number;
  personId: string;
  twin: TwinName;
  reason: string;
  becauseSeq: number;
  subject: string;
  text: string;
  channel?: string;
}

export interface RunDoc extends RunDetail {
  /** Copied off the spec at start, so a finished run re-scores with no spec. */
  checklist: Criterion[];
  /** Monotonic across the whole run — AgentStep.seq is a judge-visible id. */
  nextSeq: number;
  /** Answers the world owes the agent, scheduled a tick or two out. */
  pending: PendingReply[];
  /** Beat refs the agent has acted on, for the deterministic checklist. */
  touchedRefs: string[];
  escalations: number;
}

const timers = globalThis as unknown as { __sonataRunTimers?: Map<string, ReturnType<typeof setTimeout>> };

function timerMap(): Map<string, ReturnType<typeof setTimeout>> {
  if (!timers.__sonataRunTimers) timers.__sonataRunTimers = new Map();
  return timers.__sonataRunTimers;
}

// ---------------------------------------------------------------------------
// Deterministic randomness. Two runs of the same spec on the same model must
// tell the same story, so nothing here calls Math.random.
// ---------------------------------------------------------------------------

function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Reading a run
// ---------------------------------------------------------------------------

export function toSummary(doc: RunDoc): RunSummary {
  const { ticks: _ticks, checklist: _c, nextSeq: _n, pending: _p, touchedRefs: _t, escalations: _e, story: _s, task: _k, clock: _cl, ...summary } = doc;
  return summary;
}

/** The whole run, minus the bookkeeping only the tick loop cares about. */
export function toDetail(doc: RunDoc): RunDetail {
  const { checklist: _c, nextSeq: _n, pending: _p, touchedRefs: _t, escalations: _e, ...detail } = doc;
  return detail;
}

export function getRun(runId: string): RunDoc | undefined {
  return getDoc<RunDoc>("run", runId);
}

export function listRuns(): RunSummary[] {
  return listDocs<RunDoc>("run").map(toSummary);
}

/** The run the dashboard should be showing: the newest one still moving. */
export function activeRun(): RunDoc | undefined {
  return listDocs<RunDoc>("run").find(
    (run) => run.status === "running" || run.status === "queued" || run.status === "judging",
  );
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

export function startRun(input: StartRunInput): RunDoc {
  const episode = getEpisode(input.episodeId);
  if (!episode) throw new Error(`No scenario with id ${input.episodeId}`);

  const requested = Math.max(4, Math.min(Math.round(input.ticks), 96));
  const twins = input.twins.length > 0 ? input.twins : episode.twins;
  const now = Date.now();
  const clock = { ...episode.spec.clock, ticks: requested };

  const doc: RunDoc = {
    runId: newId("run"),
    specId: episode.id,
    specTitle: episode.title,
    model: input.model,
    status: "running",
    startedAt: now,
    endedAt: null,
    durationMs: 0,
    tickCount: 0,
    plannedTicks: requested,
    twins,
    simTimeISO: tickToISO(clock, 0),
    paused: false,
    score: null,
    autonomy: null,
    cost: null,
    story: episode.story,
    task: episode.task,
    clock,
    ticks: [],
    checklist: episode.spec.success.checklist,
    nextSeq: 1,
    pending: [],
    touchedRefs: [],
    escalations: 0,
  };

  putDoc("run", doc.runId, doc);
  mirrorRunStart({
    runId: doc.runId,
    episodeId: episode.id,
    episodeTitle: episode.title,
    worldName: episode.worldName,
    model: doc.model,
    totalTicks: requested,
    startedAt: now,
  });
  schedule(doc.runId, 200);
  return doc;
}

/** The saved artifact shape, for the mirror and for anything re-judging later. */
function toEpisodeRun(doc: RunDoc): EpisodeRun {
  return {
    runId: doc.runId,
    specId: doc.specId,
    specTitle: doc.specTitle,
    model: doc.model,
    status: doc.status,
    startedAt: doc.startedAt,
    endedAt: doc.endedAt,
    ticks: doc.ticks,
    // Snapshots need live twins either side of the agent; the stand-in tick loop
    // has none, so the field is honestly empty rather than faked.
    snapshots: {},
    verdict: null,
    ...(doc.error ? { error: doc.error } : {}),
  };
}

function schedule(runId: string, delay = MS_PER_TICK): void {
  const map = timerMap();
  const existing = map.get(runId);
  if (existing) clearTimeout(existing);
  map.set(
    runId,
    setTimeout(() => {
      map.delete(runId);
      try {
        step(runId);
      } catch {
        // A tick that throws must not take the process with it; the run is
        // marked failed on the doc so the dashboard can say what happened.
        const doc = getRun(runId);
        if (doc) {
          doc.status = "failed";
          doc.error = "The run stopped unexpectedly while advancing the day.";
          doc.endedAt = Date.now();
          doc.durationMs = doc.endedAt - doc.startedAt;
          putDoc("run", runId, doc);
          // Home polls the relational index; without this the run would sit at
          // "running" with a frozen clock and no way to find out why.
          mirrorRunFinish({
            run: toEpisodeRun(doc),
            spec: getEpisode(doc.specId)?.spec ?? null,
            checklist: scoreChecklist(doc),
          });
        }
      }
    }, delay),
  );
}

function step(runId: string): void {
  const doc = getRun(runId);
  if (!doc || doc.status !== "running" || doc.paused) return;

  const episode = getEpisode(doc.specId);
  const tick = doc.tickCount;
  const record = advanceTick(doc, episode?.spec, tick);

  doc.ticks.push(record);
  doc.tickCount = tick + 1;
  doc.simTimeISO = tickToISO(doc.clock, Math.min(doc.tickCount, doc.plannedTicks));
  doc.durationMs = Date.now() - doc.startedAt;

  const lastEvent = lastEventLine(record);
  mirrorRunProgress(runId, {
    tick: doc.tickCount,
    simTime: doc.simTimeISO,
    ...(lastEvent ? { lastEvent } : {}),
  });

  if (doc.tickCount >= doc.plannedTicks) {
    finish(doc, episode?.spec);
  } else {
    putDoc("run", runId, doc);
    schedule(runId);
  }
}

// ---------------------------------------------------------------------------
// One tick. STAND-IN — see the file header.
// ---------------------------------------------------------------------------

const READ_TOOLS: Record<TwinName, string> = {
  gmail: "gmail.list_threads",
  slack: "slack.conversations_history",
  calendar: "calendar.list_events",
};

const WRITE_TOOLS: Record<TwinName, string> = {
  gmail: "gmail.send_reply",
  slack: "slack.post_message",
  calendar: "calendar.update_event",
};

function personName(spec: EpisodeSpec | undefined, ref: string): string {
  if (!spec) return ref;
  return resolvePerson(spec.world, ref)?.name ?? ref;
}

function beatSummaryLine(spec: EpisodeSpec | undefined, beat: Beat): string {
  const who = personName(spec, beatActor(beat));
  if (beat.twin === "gmail") return `${who} emailed — "${beat.payload.subject}"`;
  if (beat.twin === "slack" && beat.kind === "message") return `${who} posted in #${beat.payload.channel}`;
  if (beat.twin === "slack") return `${who} reacted with :${beat.payload.emoji}:`;
  if (beat.kind === "invite") return `${who} invited the room to "${beat.payload.title}"`;
  if (beat.kind === "move") return `A meeting moved${beat.payload.reason ? ` — ${beat.payload.reason}` : ""}`;
  if (beat.kind === "cancel") return "A meeting was cancelled";
  return `${who} responded to an invite`;
}

function beatActor(beat: Beat): string {
  if (beat.twin === "gmail") return beat.payload.from;
  if (beat.twin === "slack") return beat.payload.from;
  if (beat.kind === "invite") return beat.payload.organizer;
  if (beat.kind === "rsvp") return beat.payload.who;
  return "the calendar";
}

function advanceTick(doc: RunDoc, spec: EpisodeSpec | undefined, tick: number): TickRecord {
  const startedAt = Date.now();
  const random = rng(seedFrom(`${doc.runId}:${doc.model}:${tick}`));
  const simTimeISO = tickToISO(doc.clock, tick);
  const notes: string[] = [];

  const due = (spec?.beats ?? []).filter((b) => b.tick === tick);
  const beatsFired: BeatFired[] = due.map((beat) => ({
    beatId: beat.id,
    ...(beat.ref ? { ref: beat.ref } : {}),
    twin: beat.twin,
    kind: beat.kind,
    handle: {
      twin: beat.twin,
      id: `sim-${beat.id}`,
      url: TWIN_URLS[beat.twin],
    },
    summary: beatSummaryLine(spec, beat),
  }));

  // What the world says back, scheduled by earlier ticks.
  const directorEvents: DirectorEvent[] = [];
  const stillPending: PendingReply[] = [];
  for (const reply of doc.pending) {
    if (reply.fireTick > tick) {
      stillPending.push(reply);
      continue;
    }
    directorEvents.push(
      reply.twin === "slack"
        ? {
            twin: "slack",
            kind: "message",
            payload: { channel: reply.channel ?? "general", from: reply.personId, text: reply.text },
            id: newId("dir"),
            personId: reply.personId,
            reason: reply.reason,
            becauseSeq: reply.becauseSeq,
            handle: { twin: "slack", id: `sim-${newId("msg")}`, url: TWIN_URLS.slack },
          }
        : {
            twin: "gmail",
            kind: "email",
            payload: {
              from: reply.personId,
              to: [spec?.world.mailboxOwner ?? "owner"],
              subject: reply.subject,
              body: reply.text,
            },
            id: newId("dir"),
            personId: reply.personId,
            reason: reply.reason,
            becauseSeq: reply.becauseSeq,
            handle: { twin: "gmail", id: `sim-${newId("msg")}`, url: TWIN_URLS.gmail },
          },
    );
  }
  doc.pending = stillPending;

  // What the agent did about it.
  const agentSteps: AgentStep[] = [];
  const at = Date.now();
  const seq = () => doc.nextSeq++;

  const arrivals = beatsFired.length + directorEvents.length;
  if (arrivals === 0 && random() > 0.35) {
    notes.push("Nothing new arrived; the agent checked its queue and waited.");
  } else {
    const surfaces = new Set<TwinName>([
      ...beatsFired.map((b) => b.twin),
      ...directorEvents.map((d) => d.twin),
    ]);
    agentSteps.push({
      kind: "thought",
      seq: seq(),
      at,
      text:
        arrivals > 0
          ? `${arrivals} new item${arrivals === 1 ? "" : "s"} since the last check. Reading before acting.`
          : "Nothing new arrived. Re-reading what is still open.",
    });

    for (const twin of surfaces.size > 0 ? surfaces : new Set<TwinName>([doc.twins[0] ?? "gmail"])) {
      if (!doc.twins.includes(twin)) continue;
      agentSteps.push({
        kind: "tool",
        seq: seq(),
        at,
        twin,
        name: READ_TOOLS[twin],
        args: { since: simTimeISO },
        resultSummary: `${arrivals} item${arrivals === 1 ? "" : "s"} unread`,
        isMutation: false,
      });
    }

    for (const fired of beatsFired) {
      if (!doc.twins.includes(fired.twin)) {
        notes.push(`${fired.summary} — but ${fired.twin} is not attached to this run.`);
        continue;
      }
      // Some things get answered, some get read and left — that difference is
      // what the checklist and the autonomy score are measuring.
      if (random() > 0.28) {
        const stepSeq = seq();
        agentSteps.push({
          kind: "tool",
          seq: stepSeq,
          at,
          twin: fired.twin,
          name: WRITE_TOOLS[fired.twin],
          args: { ref: fired.ref ?? fired.beatId, twin: fired.twin },
          resultSummary: `acted on ${fired.summary}`,
          isMutation: true,
        });
        if (fired.ref && !doc.touchedRefs.includes(fired.ref)) doc.touchedRefs.push(fired.ref);

        const beat = due.find((b) => b.id === fired.beatId);
        const actor = beat ? beatActor(beat) : undefined;
        if (actor && random() > 0.45 && tick + 2 < doc.plannedTicks) {
          doc.pending.push({
            fireTick: tick + 1 + Math.round(random()),
            personId: actor,
            twin: fired.twin === "slack" ? "slack" : "gmail",
            reason: `${personName(spec, actor)} is answering the agent`,
            becauseSeq: stepSeq,
            subject: `Re: ${fired.summary.replace(/^.*— "?|"$/g, "") || "your message"}`,
            text: "Thanks — that answers it. One thing though: can you confirm the timing before end of day?",
            ...(beat && beat.twin === "slack" && beat.kind === "message"
              ? { channel: beat.payload.channel }
              : {}),
          });
        }
      } else {
        notes.push(`Read but not acted on: ${fired.summary}`);
      }
    }

    // Handing the job back to a human is the thing autonomy measures, so it is
    // its own step kind rather than a sentence buried in a reply.
    if (random() > 0.94) {
      doc.escalations += 1;
      agentSteps.push({
        kind: "escalation",
        seq: seq(),
        at,
        text: "This needs a decision I should not make alone — flagging it for you.",
      });
    }
  }

  return {
    tick,
    simTimeISO,
    startedAt,
    endedAt: Date.now(),
    beatsFired,
    directorEvents,
    agentSteps,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Finishing. The deterministic checklist first — the judge is a separate pass
// over the saved run and does not block a score appearing.
// ---------------------------------------------------------------------------

function scoreChecklist(doc: RunDoc): CriterionResult[] {
  const touched = new Set(doc.touchedRefs);
  const mutatedTwins = new Set<TwinName>();
  for (const record of doc.ticks) {
    for (const step of record.agentSteps) {
      if (step.kind === "tool" && step.isMutation && step.twin) mutatedTwins.add(step.twin);
    }
  }

  return doc.checklist.map((criterion) => {
    let passed: boolean;
    let evidence: string;

    if (criterion.kind === "no-escalation") {
      passed = doc.escalations === 0;
      evidence = passed
        ? "The agent never handed the day back."
        : `Handed back to a human ${doc.escalations} time${doc.escalations === 1 ? "" : "s"}.`;
    } else if (criterion.kind === "untouched") {
      passed = !criterion.ref || !touched.has(criterion.ref);
      evidence = passed ? "Left alone, as it should have been." : `The agent acted on ${criterion.ref}.`;
    } else if (criterion.ref) {
      passed = touched.has(criterion.ref);
      evidence = passed ? `Acted on ${criterion.ref}.` : `Nothing in the run touched ${criterion.ref}.`;
    } else {
      passed = criterion.twin === "any" || mutatedTwins.has(criterion.twin);
      evidence = passed
        ? `The agent wrote to ${criterion.twin === "any" ? "at least one surface" : criterion.twin}.`
        : `Nothing was written to ${criterion.twin}.`;
    }

    const tick = passed
      ? doc.ticks.find((record) =>
          record.agentSteps.some(
            (step) =>
              step.kind === "tool" &&
              step.isMutation &&
              typeof step.args === "object" &&
              step.args !== null &&
              "ref" in step.args &&
              String((step.args as { ref: unknown }).ref) === criterion.ref,
          ),
        )?.tick
      : undefined;

    return {
      id: criterion.id,
      description: criterion.description,
      twin: criterion.twin,
      kind: criterion.kind,
      severity: criterion.severity,
      weight: criterion.weight,
      passed,
      evidence,
      ...(tick === undefined ? {} : { tick }),
    };
  });
}

function finish(doc: RunDoc, spec: EpisodeSpec | undefined): void {
  const checklist = scoreChecklist(doc);
  doc.status = "done";
  doc.endedAt = Date.now();
  doc.durationMs = doc.endedAt - doc.startedAt;
  doc.score = checklistScore(checklist);
  doc.autonomy = autonomyScore(checklist, []);
  doc.error = undefined;
  putDoc("run", doc.runId, doc);
  mirrorRunFinish({ run: toEpisodeRun(doc), spec: spec ?? null, checklist });
}

/** The finished run's verdict, rebuilt from the saved ticks. */
export function verdictFor(doc: RunDoc): {
  outcome: "pass" | "partial" | "fail";
  checklist: CriterionResult[];
} {
  const checklist = scoreChecklist(doc);
  return { outcome: verdictOutcome(checklist), checklist };
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

export function pauseRun(runId: string): RunDoc | undefined {
  const doc = getRun(runId);
  if (!doc || doc.status !== "running") return doc;
  const timer = timerMap().get(runId);
  if (timer) clearTimeout(timer);
  timerMap().delete(runId);
  doc.paused = true;
  putDoc("run", runId, doc);
  return doc;
}

export function resumeRun(runId: string): RunDoc | undefined {
  const doc = getRun(runId);
  if (!doc || doc.status !== "running" || !doc.paused) return doc;
  doc.paused = false;
  putDoc("run", runId, doc);
  schedule(runId, 200);
  return doc;
}

export function abortRun(runId: string): RunDoc | undefined {
  const doc = getRun(runId);
  if (!doc) return undefined;
  const timer = timerMap().get(runId);
  if (timer) clearTimeout(timer);
  timerMap().delete(runId);
  if (doc.status === "running" || doc.status === "queued") {
    doc.status = "aborted";
    doc.paused = false;
    doc.endedAt = Date.now();
    doc.durationMs = doc.endedAt - doc.startedAt;
    // A day that was stopped early still scored whatever it scored.
    const checklist = scoreChecklist(doc);
    doc.score = checklistScore(checklist);
    doc.autonomy = autonomyScore(checklist, []);
    putDoc("run", runId, doc);
    mirrorRunFinish({
      run: toEpisodeRun(doc),
      spec: getEpisode(doc.specId)?.spec ?? null,
      checklist,
    });
  }
  return doc;
}

/**
 * Re-arm any run that was mid-day when the process restarted. Next reloads route
 * modules freely in development, and a run whose timer died would otherwise sit
 * at "running" forever with a frozen clock.
 */
export function resumeInterruptedRuns(): void {
  for (const doc of listDocs<RunDoc>("run")) {
    if (doc.status !== "running" || doc.paused) continue;
    if (timerMap().has(doc.runId)) continue;
    schedule(doc.runId, 400);
  }
}
