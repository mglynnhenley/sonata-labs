import {
  tickLabel,
  tickToISO,
  type Beat,
  type BeatBody,
  type Clock,
  type Criterion,
  type CriterionKind,
  type EpisodeSpec,
  type Person,
  type TwinName,
  type WorldSeed,
} from "@sonata/core";
import type { BeatPreview, ScenarioDraft, WorldCounts } from "./types";
import { newId } from "./store";

// The middle language between "someone described a business" and an EpisodeSpec.
//
// Both producers — the model in draft.ts and the hand-written templates — emit
// this same loose shape, and this file is the only thing that turns it into the
// strict @sonata/core types. That split is deliberate: prose is the model's job,
// identity and time are code's. The model never invents an email address, a
// Slack id or an ISO timestamp, because those are the joins that make the clone
// coherent and a hallucinated one silently breaks the world.

export interface AuthoredPerson {
  name: string;
  role: string;
  /** How they stand to the mailbox owner: "manager", "peer", "client", "vendor". */
  relationship: string;
  /** Style notes: sentence length, greeting, quirks, mood. */
  voice: string;
}

export interface AuthoredChannel {
  name: string;
  purpose: string;
  /** Cast names. Anything unrecognised is dropped rather than invented. */
  members: string[];
  isPrivate?: boolean;
}

/** The four beat kinds a generated day is allowed to use. */
export type AuthoredBeatKind = "email" | "message" | "invite" | "move";

export interface AuthoredBeat {
  tick: number;
  twin: TwinName;
  kind: AuthoredBeatKind;
  /** Name this beat so later beats and criteria can point at what it created. */
  ref?: string;
  /** Author's note, shown in the run timeline and never to the agent. */
  note?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  inReplyTo?: string;
  channel?: string;
  text?: string;
  threadRef?: string;
  title?: string;
  attendees?: string[];
  durationMinutes?: number;
  eventRef?: string;
  reason?: string;
}

export interface AuthoredCriterion {
  description: string;
  twin: TwinName | "any";
  kind: CriterionKind;
  ref?: string;
  expect?: string;
  target?: string;
  severity: "must" | "should";
  weight?: number;
}

export interface AuthoredEpisode {
  title: string;
  story: string;
  task: string;
  beats: AuthoredBeat[];
  criteria: AuthoredCriterion[];
}

export interface AuthoredScenario {
  business: { name: string; industry: string; size: number; description: string };
  /** Cast name of the person whose accounts the agent operates. */
  owner: string;
  cast: AuthoredPerson[];
  channels: AuthoredChannel[];
  episode: AuthoredEpisode;
}

// ---------------------------------------------------------------------------
// Identity. Derived, never authored — see the file header.
// ---------------------------------------------------------------------------

export function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function emailDomain(businessName: string): string {
  const base = slug(businessName).replace(/-/g, "");
  return `${base || "acme"}.com`;
}

function toPerson(authored: AuthoredPerson, domain: string): Person {
  const id = slug(authored.name) || newId("person");
  const parts = authored.name.trim().split(/\s+/);
  const local = parts.length > 1 ? `${slug(parts[0]!)}.${slug(parts[parts.length - 1]!)}` : id;
  return {
    id,
    name: authored.name,
    email: `${local}@${domain}`,
    slackUserId: `U${id.replace(/-/g, "").toUpperCase().slice(0, 10)}`,
    role: authored.role,
    relationship: authored.relationship,
    voice: authored.voice,
  };
}

// ---------------------------------------------------------------------------
// The clock. A generated day always starts at 09:00 on the next weekday, in the
// host's own UTC offset — so the times a user reads in the preview are the times
// they would read on their own calendar, and the offset is explicit, which
// @sonata/core's clock requires.
// ---------------------------------------------------------------------------

function offsetSuffix(at: Date): string {
  const minutes = -at.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function nextWorkdayClock(ticks: number, simMinutesPerTick = 15): Clock {
  const day = new Date();
  day.setHours(9, 0, 0, 0);
  if (Date.now() > day.getTime()) day.setDate(day.getDate() + 1);
  while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() + 1);

  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  return { startISO: `${date}T09:00:00${offsetSuffix(day)}`, ticks, simMinutesPerTick };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function resolveRef(name: string | undefined, byName: Map<string, Person>): string | undefined {
  if (!name) return undefined;
  const person = byName.get(name.trim().toLowerCase());
  // Not in the cast: keep the raw string. A stranger emailing in is a real beat,
  // and inventing a cast member for them would corrupt the shared cast.
  return person ? person.id : name.trim();
}

function buildBody(
  beat: AuthoredBeat,
  byName: Map<string, Person>,
  channels: Set<string>,
  clock: Clock,
  ownerId: string,
): BeatBody | null {
  const from = resolveRef(beat.from, byName) ?? ownerId;

  if (beat.twin === "gmail" && beat.kind === "email") {
    const to = (beat.to ?? []).map((t) => resolveRef(t, byName)).filter((t): t is string => !!t);
    if (!beat.subject || !beat.body) return null;
    return {
      twin: "gmail",
      kind: "email",
      payload: {
        from,
        to: to.length > 0 ? to : [ownerId],
        ...(beat.cc?.length
          ? { cc: beat.cc.map((c) => resolveRef(c, byName)).filter((c): c is string => !!c) }
          : {}),
        subject: beat.subject,
        body: beat.body,
        ...(beat.inReplyTo ? { inReplyTo: beat.inReplyTo } : {}),
      },
    };
  }

  if (beat.twin === "slack" && beat.kind === "message") {
    const channel = beat.channel?.replace(/^#/, "").trim();
    if (!beat.text || !channel || !channels.has(channel)) return null;
    return {
      twin: "slack",
      kind: "message",
      payload: {
        channel,
        from,
        text: beat.text,
        ...(beat.threadRef ? { threadRef: beat.threadRef } : {}),
      },
    };
  }

  if (beat.twin === "calendar" && beat.kind === "invite") {
    if (!beat.title) return null;
    const minutes = Math.max(15, Math.min(beat.durationMinutes ?? 30, 240));
    const startISO = tickToISO(clock, beat.tick);
    return {
      twin: "calendar",
      kind: "invite",
      payload: {
        title: beat.title,
        organizer: from,
        attendees: (beat.attendees ?? [])
          .map((a) => resolveRef(a, byName))
          .filter((a): a is string => !!a),
        startISO,
        endISO: new Date(Date.parse(startISO) + minutes * 60_000).toISOString(),
      },
    };
  }

  if (beat.twin === "calendar" && beat.kind === "move") {
    if (!beat.eventRef) return null;
    const minutes = Math.max(15, Math.min(beat.durationMinutes ?? 30, 240));
    const startISO = tickToISO(clock, beat.tick + 2);
    return {
      twin: "calendar",
      kind: "move",
      payload: {
        eventRef: beat.eventRef,
        startISO,
        endISO: new Date(Date.parse(startISO) + minutes * 60_000).toISOString(),
        ...(beat.reason ? { reason: beat.reason } : {}),
      },
    };
  }

  return null;
}

/** One line for the timeline and the preview: who did what, on which surface. */
export function beatSummary(beat: AuthoredBeat, byName: Map<string, Person>): string {
  const who = beat.from ? (byName.get(beat.from.trim().toLowerCase())?.name ?? beat.from) : "The world";
  if (beat.kind === "email") return `${who} emails — "${beat.subject ?? "no subject"}"`;
  if (beat.kind === "message") return `${who} posts in #${(beat.channel ?? "general").replace(/^#/, "")}`;
  if (beat.kind === "invite") return `${who} invites everyone to "${beat.title ?? "a meeting"}"`;
  return `"${beat.eventRef ?? "a meeting"}" moves${beat.reason ? ` — ${beat.reason}` : ""}`;
}

/**
 * What the seeder will write into the three twins. Derived from the cast and the
 * day rather than asked for, so the preview's numbers are the numbers — a model
 * that guesses "about 20 threads" and a seeder that writes 14 is exactly the
 * kind of small lie that makes a product feel untrustworthy.
 */
export function plannedCounts(seed: WorldSeed, beats: Beat[]): WorldCounts {
  const people = seed.cast.length;
  const channels = seed.channels.length;
  const backlogThreads = people * 2 + 4;
  const beatEmails = beats.filter((b) => b.twin === "gmail").length;
  return {
    people,
    threads: backlogThreads + beatEmails,
    messages: backlogThreads * 2 + beatEmails,
    channels,
    slackMessages: channels * 8 + beats.filter((b) => b.twin === "slack").length,
    events: people * 2 + beats.filter((b) => b.twin === "calendar").length,
  };
}

export interface AssembledScenario {
  seed: WorldSeed;
  spec: EpisodeSpec;
  draft: ScenarioDraft;
}

export interface AssembleOptions {
  brief: string;
  ticks: number;
  simMinutesPerTick?: number;
  /** True when no model was involved — surfaced in the preview, not hidden. */
  offline: boolean;
  /** Why, when offline. Travels into the draft so the fallback is never silent. */
  offlineReason?: string;
}

/**
 * Authored scenario → WorldSeed + EpisodeSpec + the preview the modal renders.
 * Everything unresolvable is dropped, not guessed: a beat pointing at a channel
 * that does not exist would be a silent no-op three hours into a benchmark.
 */
export function assembleScenario(
  authored: AuthoredScenario,
  options: AssembleOptions,
): AssembledScenario {
  const domain = emailDomain(authored.business.name);
  const cast = authored.cast.map((p) => toPerson(p, domain));
  const byName = new Map(cast.map((p) => [p.name.trim().toLowerCase(), p]));
  const owner = byName.get(authored.owner.trim().toLowerCase()) ?? cast[0];
  if (!owner) throw new Error("a world needs at least one person in its cast");

  const channels = authored.channels.map((c) => {
    const name = c.name.replace(/^#/, "").trim();
    const members = c.members
      .map((m) => byName.get(m.trim().toLowerCase())?.id)
      .filter((m): m is string => !!m);
    return {
      id: `C${slug(name).replace(/-/g, "").toUpperCase().slice(0, 10)}`,
      name,
      purpose: c.purpose,
      // The mailbox owner is a member of anything they can read.
      members: members.includes(owner.id) ? members : [owner.id, ...members],
      isPrivate: c.isPrivate ?? false,
    };
  });

  const seed: WorldSeed = {
    business: {
      name: authored.business.name,
      description: authored.business.description,
      industry: authored.business.industry,
      size: authored.business.size,
    },
    cast,
    channels,
    mailboxOwner: owner.id,
  };

  const clock = nextWorkdayClock(options.ticks, options.simMinutesPerTick ?? 15);
  const channelNames = new Set(channels.map((c) => c.name));

  const sorted = [...authored.episode.beats].sort((a, b) => a.tick - b.tick);
  const beats: Beat[] = [];
  const previews: BeatPreview[] = [];
  for (const authoredBeat of sorted) {
    const tick = Math.max(0, Math.min(Math.round(authoredBeat.tick), clock.ticks - 1));
    const body = buildBody({ ...authoredBeat, tick }, byName, channelNames, clock, owner.id);
    if (!body) continue;
    beats.push({
      ...body,
      id: newId("beat"),
      tick,
      ...(authoredBeat.ref ? { ref: authoredBeat.ref } : {}),
      ...(authoredBeat.note ? { note: authoredBeat.note } : {}),
    });
    previews.push({
      tick,
      timeLabel: tickLabel(clock, tick),
      twin: body.twin,
      kind: body.kind,
      summary: authoredBeat.note ?? beatSummary({ ...authoredBeat, tick }, byName),
    });
  }

  const definedRefs = new Set(beats.map((b) => b.ref).filter((r): r is string => !!r));
  const checklist: Criterion[] = authored.episode.criteria
    // A criterion pointing at a beat that never fires can never pass; drop it
    // rather than shipping a scenario nobody can score.
    .filter((c) => !c.ref || definedRefs.has(c.ref))
    .map((c, index) => ({
      id: `c${index + 1}`,
      description: c.description,
      twin: c.twin,
      kind: c.kind,
      ...(c.ref ? { ref: c.ref } : {}),
      ...(c.expect ? { expect: c.expect } : {}),
      ...(c.target ? { target: resolveRef(c.target, byName) ?? c.target } : {}),
      weight: c.weight ?? 1,
      severity: c.severity,
    }));

  const spec: EpisodeSpec = {
    id: newId("ep"),
    title: authored.episode.title,
    story: authored.episode.story,
    task: authored.episode.task,
    world: seed,
    clock,
    beats,
    director: {
      maxEventsPerTick: 2,
      personas: cast
        .filter((p) => p.id !== owner.id)
        .map((p) => ({
          personId: p.id,
          responsiveness: p.relationship === "client" ? 0.7 : 0.85,
          replyDelayTicks: p.relationship === "client" ? 2 : 1,
          // A client lives outside the company, so they never appear in Slack.
          surfaces:
            p.relationship === "client" || p.relationship === "vendor"
              ? (["gmail"] as TwinName[])
              : (["gmail", "slack"] as TwinName[]),
        })),
      offLimits: [
        "Never tell the agent what to do next, or name the action it should take.",
        "Never volunteer a fact it has not asked for.",
      ],
      style: "Short, busy, specific. Write like someone with six other things open.",
    },
    success: {
      checklist,
      judgeQuestions: [
        "Did the agent connect what it read across the surfaces it had, or work one surface at a time?",
        "Where it handed something back to a human, could it have acted instead?",
      ],
    },
    termination: {
      stopWhenAllMustPass: false,
      idleTicks: 6,
      maxWallClockMs: 20 * 60_000,
      maxCostUsd: 2,
    },
  };

  const usedTwins = new Set<TwinName>(beats.map((b) => b.twin));
  for (const c of checklist) if (c.twin !== "any") usedTwins.add(c.twin);

  const draft: ScenarioDraft = {
    draftId: newId("draft"),
    brief: options.brief,
    createdAt: Date.now(),
    offline: options.offline,
    ...(options.offlineReason ? { offlineReason: options.offlineReason } : {}),
    business: {
      name: seed.business.name,
      industry: seed.business.industry,
      size: seed.business.size,
      description: seed.business.description,
    },
    counts: plannedCounts(seed, beats),
    cast: cast.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      email: p.email,
      relationship: p.relationship,
    })),
    channels: channels.map((c) => ({
      name: c.name,
      purpose: c.purpose,
      memberCount: c.members.length,
    })),
    episode: {
      title: spec.title,
      story: spec.story,
      task: spec.task,
      ticks: clock.ticks,
      simMinutesPerTick: clock.simMinutesPerTick,
      startISO: clock.startISO,
      twins: (["gmail", "slack", "calendar"] as TwinName[]).filter((t) => usedTwins.has(t)),
      beats: previews,
      criteria: checklist.map((c) => ({
        description: c.description,
        twin: c.twin,
        severity: c.severity,
      })),
    },
  };

  return { seed, spec, draft };
}
