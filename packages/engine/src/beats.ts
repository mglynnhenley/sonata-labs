import {
  resolvePerson,
  type AttioBeatBody,
  type AttioWriteValue,
  type Beat,
  type BeatBody,
  type BeatFired,
  type ByTwin,
  type CalendarBeatBody,
  type GoogleAdsBeatBody,
  type GoogleDocsBeatBody,
  type InjectedRef,
  type LinkedInBeatBody,
  type TwinAdapter,
  type WorldSeed,
} from "@sonata/core";
import { errorMessage } from "./http";

// The script. Beats are everything the day does on its own — the angry client at
// 09:15, the escalation in #ops at 11:00 — fixed in advance so that two models
// run against the same day and the comparison means something. Everything
// reactive comes from the director instead.
//
// A beat and a director event carry the same (twin, kind, payload) triple, so
// both are injected by `injectBody` below. The only difference is who wrote it.

/** Beats indexed by the tick they fire on, in author order within a tick. */
export interface BeatSchedule {
  at(tick: number): Beat[];
  /** Ticks that have at least one beat, ascending. */
  ticks(): number[];
  readonly count: number;
}

export function scheduleBeats(beats: Beat[]): BeatSchedule {
  const byTick = new Map<number, Beat[]>();
  for (const beat of beats) {
    const list = byTick.get(beat.tick);
    // Push rather than sort: author order within a tick is meaningful (the email
    // that starts a thread must land before the reply that answers it), and the
    // spec's array order is the only record of it.
    if (list) list.push(beat);
    else byTick.set(beat.tick, [beat]);
  }
  return {
    at: (tick) => byTick.get(tick) ?? [],
    ticks: () => [...byTick.keys()].sort((a, b) => a - b),
    count: beats.length,
  };
}

/** Beats scheduled outside the day — authoring mistakes that would never fire. */
export function unreachableBeats(beats: Beat[], ticks: number): Beat[] {
  return beats.filter((b) => !Number.isInteger(b.tick) || b.tick < 0 || b.tick >= ticks);
}

// ---------------------------------------------------------------------------
// Refs. A beat names what it creates ("the escalation email"); later beats,
// director events and success criteria point at that name. The registry is what
// turns the name into the id the twin actually minted.
// ---------------------------------------------------------------------------

export interface RefRegistry {
  record(ref: string | undefined, handle: InjectedRef): void;
  resolve(ref: string): InjectedRef | undefined;
  /** Everything resolved so far — carried into the artifact for the checkers. */
  entries(): Record<string, InjectedRef>;
}

export function createRefRegistry(initial: Record<string, InjectedRef> = {}): RefRegistry {
  const map = new Map<string, InjectedRef>(Object.entries(initial));
  return {
    record(ref, handle) {
      // First writer wins: a ref names one artefact, and a second beat quietly
      // rebinding it would silently redirect every criterion pointing at it.
      if (ref && !map.has(ref)) map.set(ref, handle);
    },
    resolve: (ref) => map.get(ref),
    entries: () => Object.fromEntries(map),
  };
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

export interface InjectDeps {
  adapters: ByTwin<TwinAdapter>;
  world: WorldSeed;
  refs: RefRegistry;
}

function nameOf(world: WorldSeed, ref: string): string {
  return resolvePerson(world, ref)?.name ?? ref;
}

/**
 * Who acted, on the two surfaces where naming nobody is legitimate — and the two
 * of them mean different people by it. A LinkedIn beat with no `from` is the
 * company page speaking; a document with no owner belongs to whoever owns the
 * workspace, which is the mailbox owner. Neither is a missing value, so each
 * says which it is.
 */
function actorOf(world: WorldSeed, ref: string | undefined, whenAbsent: string): string {
  return ref ? nameOf(world, ref) : whenAbsent;
}

/** What a CRM record is called, out of the attribute bag a beat writes. */
function recordName(values: Record<string, AttioWriteValue>): string {
  const name = values.name;
  if (Array.isArray(name)) return name.length ? String(name[0]) : "an unnamed record";
  return typeof name === "string" && name.trim() ? name : String(name ?? "an unnamed record");
}

/** What a person calls one of the CRM's three objects, for the line's prose. */
function singular(object: string): string {
  return { companies: "company", people: "person", deals: "deal" }[object] ?? `${object} record`;
}

/** An attribute bag as a person would read it back: `stage → Won 🎉`. */
function valueList(values: Record<string, AttioWriteValue>): string {
  return Object.entries(values)
    .map(([slug, v]) => `${slug} → ${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join(", ");
}

/**
 * The campaign a beat is about, as the author named it. Either half is
 * legitimate — a name for a campaign the world was seeded with, a ref for the
 * other end of a pair — and neither is resolved here, because this line is
 * written before anything has been sent to the twin.
 */
function campaignName(payload: { campaign?: string; campaignRef?: string }): string {
  return payload.campaign ?? payload.campaignRef ?? "a campaign";
}

/** Micros as whole currency units — the ads twin counts money in millionths. */
function money(micros: number): string {
  return (micros / 1_000_000).toFixed(2);
}

/**
 * One line for the timeline: "Dana Reyes emailed about the missed SLA". Written
 * from the world's point of view, because this is what the run view shows a
 * human and what the agent's tick digest is built from.
 *
 * Split by twin before kind, and by twin into the four functions below, because
 * `reaction` is no longer one thing: a Slack emoji and a LinkedIn reaction on a
 * post are different payloads under the same word.
 */
export function summarizeBody(body: BeatBody, world: WorldSeed): string {
  switch (body.twin) {
    case "gmail": {
      const to = body.payload.to.map((r) => nameOf(world, r)).join(", ");
      return `${nameOf(world, body.payload.from)} emailed ${to}: "${body.payload.subject}"`;
    }
    case "slack":
      if (body.kind === "message") {
        const where = body.payload.channel.startsWith("#")
          ? body.payload.channel
          : `#${body.payload.channel}`;
        return `${nameOf(world, body.payload.from)} posted in ${where}: "${body.payload.text}"`;
      }
      return `${nameOf(world, body.payload.from)} reacted :${body.payload.emoji}:`;
    case "calendar":
      return summarizeCalendar(body, world);
    case "attio":
      return summarizeAttio(body, world);
    case "google-docs":
      return summarizeDocs(body, world);
    case "google-ads":
      return summarizeAds(body);
    case "linkedin":
      return summarizeLinkedIn(body, world);
  }
}

function summarizeCalendar(body: CalendarBeatBody, world: WorldSeed): string {
  switch (body.kind) {
    case "invite":
      return (
        `${nameOf(world, body.payload.organizer)} invited ` +
        `${body.payload.attendees.map((a) => nameOf(world, a)).join(", ")} to ` +
        `"${body.payload.title}" at ${body.payload.startISO}`
      );
    case "move":
      return `"${body.payload.eventRef}" moved to ${body.payload.startISO}${
        body.payload.reason ? ` (${body.payload.reason})` : ""
      }`;
    case "cancel":
      return `"${body.payload.eventRef}" cancelled${
        body.payload.reason ? ` (${body.payload.reason})` : ""
      }`;
    case "rsvp":
      return `${nameOf(world, body.payload.who)} ${body.payload.response} "${body.payload.eventRef}"`;
  }
}

function summarizeAttio(body: AttioBeatBody, world: WorldSeed): string {
  switch (body.kind) {
    case "record":
      return (
        `"${recordName(body.payload.values)}" was added to the CRM ` +
        `as a ${singular(body.payload.object)}`
      );
    case "update":
      return `"${body.payload.recordRef}" changed in the CRM: ${valueList(body.payload.values)}`;
    case "note":
      return `a note was logged on "${body.payload.parentRecordRef}": "${body.payload.title}"`;
    case "task": {
      // A task nobody holds is a real thing to script and a finding when it
      // happens, so it is said rather than left as a blank in the line.
      const who = body.payload.assignee
        ? nameOf(world, body.payload.assignee)
        : "nobody in particular";
      return `a follow-up landed on ${who}: "${body.payload.content}"`;
    }
  }
}

function summarizeDocs(body: GoogleDocsBeatBody, world: WorldSeed): string {
  switch (body.kind) {
    case "document":
      return (
        `${actorOf(world, body.payload.owner, "the workspace owner")} ` +
        `shared a document: "${body.payload.title}"`
      );
    case "append":
      return (
        `a section was added to "${body.payload.documentRef}": ` +
        `"${body.payload.paragraphs[0]?.text ?? ""}"`
      );
    case "replace":
      return (
        `"${body.payload.find}" became "${body.payload.replaceWith}" ` +
        `in "${body.payload.documentRef}"`
      );
  }
}

function summarizeAds(body: GoogleAdsBeatBody): string {
  switch (body.kind) {
    case "status": {
      const which = campaignName(body.payload);
      if (body.payload.status === "PAUSED") return `campaign "${which}" was paused`;
      if (body.payload.status === "ENABLED") return `campaign "${which}" was switched back on`;
      if (body.payload.status === "REMOVED") return `campaign "${which}" was removed`;
      return `campaign "${which}" is now ${body.payload.status}`;
    }
    case "budget":
      return (
        `campaign "${campaignName(body.payload)}" now has ` +
        `${money(body.payload.amountMicros)} a day to spend`
      );
    case "spend":
      // What the day cost, not what it sold: an overspend is the thing an agent
      // is meant to notice, and it is spend that says so.
      return (
        `${body.payload.clicks} click(s) and ${money(body.payload.costMicros)} of spend ` +
        `landed on "${body.payload.adGroup}"`
      );
  }
}

function summarizeLinkedIn(body: LinkedInBeatBody, world: WorldSeed): string {
  switch (body.kind) {
    case "post":
      return (
        `${actorOf(world, body.payload.from, "the company page")} ` +
        `posted on LinkedIn: "${body.payload.commentary}"`
      );
    case "comment":
      return (
        `${actorOf(world, body.payload.from, "the company page")} ` +
        `${body.payload.parentRef ? "replied under" : "commented on"} ` +
        `"${body.payload.parentRef ?? body.payload.postRef ?? "the feed"}": "${body.payload.text}"`
      );
    case "reaction":
      return (
        `${actorOf(world, body.payload.from, "the company page")} reacted ` +
        `${body.payload.reactionType ?? "LIKE"} to "${body.payload.entityRef}"`
      );
  }
}

export interface InjectOutcome {
  handle?: InjectedRef;
  error?: string;
}

/**
 * Play one body into its twin.
 *
 * Never throws. A twin that 500s, a route that does not exist yet, a beat
 * pointing at a ref nothing created — all of it becomes a recorded error on that
 * one beat. A run that dies at 11:00 because one injection failed teaches nothing
 * about the agent; a run where the timeline says "this did not happen, here is
 * why" teaches everything.
 */
export async function injectBody(
  body: BeatBody,
  atISO: string,
  deps: InjectDeps,
): Promise<InjectOutcome> {
  const adapter = deps.adapters[body.twin];
  if (!adapter) return { error: `no ${body.twin} adapter in this run` };
  try {
    const handle = await adapter.inject(body, {
      atISO,
      resolve: (ref) => deps.refs.resolve(ref),
      world: deps.world,
    });
    return { handle };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/** Fire this tick's beats, in order, recording what each one created. */
export async function fireBeats(
  beats: Beat[],
  atISO: string,
  deps: InjectDeps,
): Promise<BeatFired[]> {
  const fired: BeatFired[] = [];
  for (const beat of beats) {
    // Sequential on purpose: a beat may reply into the thread the previous beat
    // just created, and the ref registry only knows about it once it has landed.
    const outcome = await injectBody(beat, atISO, deps);
    if (outcome.handle) deps.refs.record(beat.ref, outcome.handle);
    fired.push({
      beatId: beat.id,
      ...(beat.ref ? { ref: beat.ref } : {}),
      twin: beat.twin,
      kind: beat.kind,
      ...(outcome.handle ? { handle: outcome.handle } : {}),
      summary: summarizeBody(beat, deps.world),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }
  return fired;
}
