import type { ChannelSeed, Person, WorldSeed } from "@sonata/core";
import { completeJSON, type CompleteJSON, type Effort } from "./llm";
import {
  asSchema,
  STORYLINE_SEEDS_SCHEMA,
  WORLD_DRAFT_SCHEMA,
  WORLD_SPINE_SCHEMA,
  type CalendarEventSeed,
  type CalendarSeed,
  type GmailSeed,
  type GmailThreadSeed,
  type SlackChannelSeed,
  type SlackSeed,
  type SpineStoryline,
  type StorylineSeeds,
  type TwinSeeds,
  type WorldDraft,
  type WorldSpine,
} from "./schema";

// ---------------------------------------------------------------------------
// "a 12-person fintech, the week before an audit" -> one coherent fake company,
// projected into Gmail, Slack and a calendar with the SAME cast.
//
// Four model passes:
//   1. the company and its people — who exists, what they do, how they write;
//   2. the SPINE — shape with no prose in it: the storylines, the channel
//      roster, the calendars, and the exact facts with who knows each one;
//   3. one writer PER STORYLINE, in parallel, each writing all three surfaces;
//   4. the ambient noise that belongs to no storyline.
// Then the merge, in code.
//
// The split is by storyline and NOT by surface. Writing the surfaces separately
// is what makes a clone feel like three unrelated fixtures: the renewal
// negotiation's emails, its argument in #renewals and the meeting about it are
// one thing, and the writer who has all three in front of it is the only cheap
// way to keep them agreeing. Coherence between unrelated storylines is weak in
// real companies anyway, and what there is of it the spine carries.
//
// One call for the whole backlog is what this replaces, and it failed three
// ways: it could not reach 12-18 people without exceeding sane output limits, it
// degraded in the TAIL (the last channels came back with two lines each), and
// one bad response lost the entire company. Now a failed writer loses one
// storyline and says so in `warnings`.
//
// The model writes PROSE ONLY. Person ids, email addresses, Slack user and
// channel ids, calendar ids, channel membership, threading and every timestamp
// are assembled below, in code. This is the same discipline the Gmail scenario
// generator runs on and it is why any of this is testable: given a fixed draft,
// `assembleWorld` is a pure function with one right answer, and `mergeStorylines`
// is another.
// ---------------------------------------------------------------------------

/** The finished clone: one world, three seeds, ready to preview or inject. */
export interface GeneratedWorld {
  /** Stable slug, from the company name. Used as the template/world id. */
  id: string;
  /** The one-line description this was grown from. */
  description: string;
  /** Provenance only. The seeds stay relative, so a world can be injected later. */
  generatedAtISO: string;
  world: WorldSeed;
  gmail: GmailSeed;
  slack: SlackSeed;
  calendar: CalendarSeed;
  /**
   * What generation could not guarantee: a storyline that failed to write, a
   * channel one writer invented off-roster, a canonical fact somebody spelled
   * their own way. Present only when there is something to say.
   *
   * These are the harness's gaps, not the world's contents. The alternative —
   * code editing the prose until the contradiction is gone — produces exactly
   * the flat filler this generator exists to avoid, so nothing here is repaired.
   */
  warnings?: string[];
  /**
   * The noise: what the ambient pass wrote, which belongs to no storyline.
   *
   * Named so nothing downstream attaches a criterion to the lunch thread. Noise
   * is the benchmark's difficulty knob — retrieval is only hard when there is
   * something to retrieve FROM — and a day that DEPENDS on the noise has made
   * its difficulty knob into its answer key.
   */
  ambient?: AmbientInventory;
}

/**
 * Subjects and summaries, spelled the way the assembled world spells them.
 *
 * A hint, not a key. It is taken before `canonicalize` runs, so a thread the
 * normalizers then drop — every sender invented — is still named here, and two
 * threads may share a subject. Good enough to leave the noise alone with;
 * never enough to resolve anything by.
 */
export interface AmbientInventory {
  threads: string[];
  events: string[];
}

export interface GenerateOptions {
  /** OpenRouter slug. Defaults to `DEFAULT_MODEL`. */
  model?: string;
  /** Reasoning effort for the narrative pass. Defaults to "high". */
  effort?: Effort;
  /**
   * The model seam. Defaults to this package's OpenRouter client; the engine
   * passes its trace-recording one so world generation lands on the run trace.
   */
  complete?: CompleteJSON;
  /** Injected clock, for reproducible `generatedAtISO`. */
  now?: number;
  /** Progress line, wired to the dashboard's clone-a-business step. */
  say?: (msg: string) => void;
  /**
   * Channel names the Slack backlog must be written in, rather than any the
   * model invents. Set when the world is grown to fit a day that already exists:
   * an episode's beats post into "#ops" by name, so a backlog that invented
   * "#operations" instead would leave every one of those beats with nowhere to
   * land. Unset means the model chooses, which is the from-scratch case.
   */
  channels?: string[];
}

const SYSTEM = [
  "You invent realistic fake companies for an offline agent-testing sandbox. Everything you write",
  "is loaded into local clones of Gmail, Slack and a calendar; none of it is ever sent to anyone",
  "and none of it describes a real company or a real person.",
  "",
  "Write the way working people actually write: unfinished sentences, shorthand, mild irritation,",
  "half-remembered context. Never mention that this is a test, a scenario, a simulation or an",
  "evaluation. No placeholders, no lorem ipsum, no disclaimers.",
].join("\n");

// ---------------------------------------------------------------------------
// Identity assembly. Everything here is a pure function of the draft, so the
// same draft always produces the same addresses.
// ---------------------------------------------------------------------------

function slug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function alnum(text: string): string {
  return text.normalize("NFKD").replace(/[^A-Za-z0-9]/g, "");
}

/** `unique("priya", seen)` -> "priya", then "priya-2", "priya-3". */
function unique(base: string, seen: Set<string>, join = "-"): string {
  let candidate = base;
  let n = 2;
  while (seen.has(candidate)) candidate = `${base}${join}${n++}`;
  seen.add(candidate);
  return candidate;
}

/** "Northwind Ledger" -> "northwindledger.com". One domain for the whole cast. */
export function companyDomain(businessName: string): string {
  const stem = alnum(businessName).toLowerCase().slice(0, 24);
  return `${stem || "sandbox"}.com`;
}

/**
 * Cast with identities attached. Ids are first names (the form beats and
 * criteria are written in), addresses are first.last on their employer's domain,
 * and Slack ids carry an ordinal so they stay unique even for two Priyas.
 *
 * Colleagues share the one company domain; a client, vendor or auditor gets
 * their own, because an auditor writing from the audited company's domain is a
 * tell an agent can read the answer off.
 */
export function assembleCast(draft: WorldDraft): Person[] {
  if (draft.people.length === 0) throw new Error("WorldDraft has no people; cannot build a cast");
  const home = slug(draft.business.name);
  const ids = new Set<string>();
  const emails = new Set<string>();

  return draft.people.map((p, i) => {
    const parts = p.name.trim().split(/\s+/);
    const first = slug(parts[0] ?? `person${i + 1}`) || `person${i + 1}`;
    const last = slug(parts.slice(1).join(" "));
    const id = unique(first, ids);
    const org = p.org?.trim();
    const domain = companyDomain(!org || slug(org) === home ? draft.business.name : org);

    const base = last ? `${first}.${last}` : first;
    let local = base;
    for (let n = 2; emails.has(`${local}@${domain}`); n++) local = `${base}.${n}`;
    emails.add(`${local}@${domain}`);

    return {
      id,
      name: p.name.trim(),
      email: `${local}@${domain}`,
      slackUserId: `U${String(i + 1).padStart(2, "0")}${alnum(first).toUpperCase().slice(0, 6)}`,
      role: p.role.trim(),
      relationship: p.relationship.trim(),
      voice: p.voice.trim(),
    };
  });
}

/** "#pre-audit prep" -> "pre-audit-prep". Slack's own rules, applied in code. */
function channelName(name: string): string {
  return slug(name.replace(/^#/, "")).slice(0, 72) || "general";
}

function channelId(name: string, index: number): string {
  return `C${String(index + 1).padStart(2, "0")}${alnum(name).toUpperCase().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Normalizers. The model references people by id and time by offset; these turn
// what it wrote into something that cannot dangle: unknown ids are dropped,
// offsets are clamped and ordered, and every implied membership is made real.
// ---------------------------------------------------------------------------

/** Gmail's system labels, which are upper-case; anything else is a user label. */
const SYSTEM_LABELS = new Set([
  "INBOX",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

function normalizeLabels(labels: string[]): string[] {
  const out: string[] = [];
  for (const raw of labels) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const upper = trimmed.toUpperCase();
    const label = SYSTEM_LABELS.has(upper) ? upper : trimmed;
    if (!out.includes(label)) out.push(label);
  }
  // A thread with no folder at all is invisible in every Gmail view.
  if (!out.some((l) => l === "INBOX" || l === "SENT" || l === "TRASH" || l === "SPAM")) {
    out.unshift("INBOX");
  }
  return out;
}

function clampMinutesAgo(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

/**
 * How long a meeting is once the world has it: five minutes at the shortest, ten
 * hours at the longest, half an hour when the model wrote nothing usable.
 *
 * Shared with the merge's clash test rather than written out twice. The merge
 * had its own copy of this without the ceiling, so an offsite a writer sized at
 * 1440 minutes blocked out a day the finished calendar never shows as busy —
 * and every third meeting inside that phantom window was dropped as a
 * double-booking against a clash that does not exist.
 */
function eventMinutes(durationMin: number): number {
  return Math.min(600, Math.max(5, Math.round(durationMin) || 30));
}

/**
 * "Re: SOC 2 evidence " -> "SOC 2 evidence". Gmail holds one subject per thread
 * and the twins write the "Re:" onto the replies themselves, so a model that
 * writes it too leaves a thread reading "Re: Re:".
 *
 * Shared with the merge rather than repeated there, so a thread the merge names
 * in its warnings or in the ambient inventory is spelled exactly as the finished
 * world spells it.
 */
function threadSubject(raw: string): string {
  return raw.trim().replace(/^\s*(re|fwd?)\s*:\s*/i, "");
}

export function normalizeGmailSeed(seed: GmailSeed, cast: Person[], ownerId: string): GmailSeed {
  const known = new Set(cast.map((p) => p.id));
  const threads: GmailSeed["threads"] = [];

  for (const thread of seed.threads ?? []) {
    const messages = (thread.messages ?? [])
      .filter((m) => known.has(m.fromPersonId))
      .map((m) => ({
        fromPersonId: m.fromPersonId,
        minutesAgo: clampMinutesAgo(m.minutesAgo),
        body: m.body.trim(),
      }))
      // Oldest first: the reader of a thread, and every "Re:" below, depends on it.
      .sort((a, b) => b.minutesAgo - a.minutesAgo);
    if (messages.length === 0) continue;

    // The mailbox owner is on every thread in their own mailbox, and so is
    // anyone who spoke — a sender missing from `participants` would get no
    // address on the follow-ups.
    const participants = [
      ...new Set([ownerId, ...messages.map((m) => m.fromPersonId), ...(thread.participants ?? [])]),
    ].filter((id) => known.has(id));

    threads.push({
      subject: threadSubject(thread.subject),
      labels: normalizeLabels(thread.labels ?? []),
      participants,
      messages,
    });
  }
  // Newest thread first, the order an inbox actually shows.
  const newest = (t: GmailSeed["threads"][number]) => t.messages[t.messages.length - 1].minutesAgo;
  threads.sort((a, b) => newest(a) - newest(b));
  return { threads };
}

export function normalizeSlackSeed(seed: SlackSeed, cast: Person[], ownerId: string): SlackSeed {
  const known = new Set(cast.map((p) => p.id));
  const names = new Set<string>();
  const channels: SlackSeed["channels"] = [];

  for (const channel of seed.channels ?? []) {
    const messages = (channel.messages ?? [])
      .filter((m) => known.has(m.personId))
      .map((m) => {
        const minutesAgo = clampMinutesAgo(m.minutesAgo);
        const replies = (m.threadReplies ?? [])
          .filter((r) => known.has(r.personId))
          // A reply cannot predate its parent; models get this wrong often enough
          // that clamping here is cheaper than re-prompting.
          .map((r) => ({
            personId: r.personId,
            minutesAgo: Math.min(minutesAgo, clampMinutesAgo(r.minutesAgo)),
            text: r.text.trim(),
          }))
          .sort((a, b) => b.minutesAgo - a.minutesAgo);
        return { personId: m.personId, minutesAgo, text: m.text.trim(), threadReplies: replies };
      })
      .sort((a, b) => b.minutesAgo - a.minutesAgo);

    const speakers = messages.flatMap((m) => [
      m.personId,
      ...m.threadReplies.map((r) => r.personId),
    ]);
    // The owner joins every channel: the agent reads Slack as them, so a channel
    // they are not in is content the run can never reach.
    const members = [...new Set([ownerId, ...(channel.members ?? []), ...speakers])].filter((id) =>
      known.has(id),
    );

    channels.push({
      name: unique(channelName(channel.name), names),
      topic: channel.topic.trim(),
      purpose: channel.purpose.trim(),
      members,
      messages,
    });
  }
  return { channels };
}

export function normalizeCalendarSeed(
  seed: CalendarSeed,
  cast: Person[],
  ownerId: string,
): CalendarSeed {
  const known = new Set(cast.map((p) => p.id));
  const owner = cast.find((p) => p.id === ownerId) ?? cast[0];
  const names = new Set<string>();

  const calendars = (seed.calendars ?? []).map((c) => ({
    name: unique(c.name.trim() || owner.name, names, " "),
    ownerPersonId: known.has(c.ownerPersonId) ? c.ownerPersonId : ownerId,
    description: c.description.trim(),
  }));
  // Every world has at least the owner's own calendar; the agent has to have
  // somewhere to put a meeting it schedules.
  if (calendars.length === 0) {
    calendars.push({ name: owner.name, ownerPersonId: ownerId, description: "Primary calendar" });
  }
  const byName = new Map(calendars.map((c) => [c.name.toLowerCase(), c]));

  const events = (seed.events ?? [])
    .map((e) => {
      const calendar = byName.get(e.calendarName?.trim().toLowerCase() ?? "") ?? calendars[0];
      const attendees = [
        ...new Set([calendar.ownerPersonId, ...(e.attendeePersonIds ?? [])]),
      ].filter((id) => known.has(id));
      const recurrence = (e.recurrence ?? "").trim().toUpperCase();
      return {
        summary: e.summary.trim(),
        calendarName: calendar.name,
        startOffsetMin: Number.isFinite(e.startOffsetMin) ? Math.round(e.startOffsetMin) : 0,
        durationMin: eventMinutes(e.durationMin),
        attendeePersonIds: attendees,
        location: (e.location ?? "").trim(),
        recurrence: recurrence.startsWith("RRULE:") ? recurrence : "",
        description: (e.description ?? "").trim(),
      };
    })
    .sort((a, b) => a.startOffsetMin - b.startOffsetMin);

  return { calendars, events };
}

/** Channels are authored once, in the Slack seed; the world reads them back. */
function channelsFromSlack(slack: SlackSeed): ChannelSeed[] {
  return slack.channels.map((c, i) => ({
    id: channelId(c.name, i),
    name: c.name,
    purpose: c.purpose,
    members: c.members,
    isPrivate: false,
  }));
}

/**
 * The mechanical tail of assembly, over a world that already has its cast: run
 * the three surfaces through the normalizers, then re-derive the channel list
 * from the Slack seed so the world and the seed cannot disagree about who is in
 * #audit-prep.
 *
 * Pure and idempotent, which is what lets the hand-written templates go through
 * it at load: a template is then indistinguishable in shape from a generated
 * world — same ordering, same membership, same repairs — so the preview, the
 * injector and the engine need no second code path, and a hand-edited template
 * cannot produce a world that generation never could.
 */
export function canonicalize(generated: GeneratedWorld): GeneratedWorld {
  const { cast, mailboxOwner } = generated.world;
  if (!cast.some((p) => p.id === mailboxOwner)) {
    throw new Error(`mailboxOwner "${mailboxOwner}" is not in the cast of "${generated.id}"`);
  }

  const slack = normalizeSlackSeed(generated.slack, cast, mailboxOwner);
  return {
    ...generated,
    world: { ...generated.world, channels: channelsFromSlack(slack) },
    gmail: normalizeGmailSeed(generated.gmail, cast, mailboxOwner),
    slack,
    calendar: normalizeCalendarSeed(generated.calendar, cast, mailboxOwner),
  };
}

/**
 * Everything mechanical, in one pure function: identities, ids, membership,
 * ordering. Given the same two model outputs it always returns the same world,
 * which is what the assembly tests pin.
 */
export function assembleWorld(
  description: string,
  draft: WorldDraft,
  seeds: TwinSeeds,
  opts: { now?: number } = {},
): GeneratedWorld {
  const cast = assembleCast(draft);
  const named = draft.mailboxOwnerName?.trim().toLowerCase();
  const ownerId = (cast.find((p) => p.name.toLowerCase() === named) ?? cast[0]).id;

  const world: WorldSeed = {
    business: {
      name: draft.business.name.trim(),
      description: draft.business.description.trim(),
      industry: draft.business.industry.trim(),
      size: Math.max(1, Math.round(draft.business.size) || cast.length),
    },
    cast,
    // Filled by `canonicalize` from the normalized Slack seed — channels exist
    // once, in one place, rather than being written down twice.
    channels: [],
    mailboxOwner: ownerId,
    ...(draft.timezone?.trim() ? { timezone: draft.timezone.trim() } : {}),
  };

  return canonicalize({
    id: slug(world.business.name) || "world",
    description,
    generatedAtISO: new Date(opts.now ?? Date.now()).toISOString(),
    world,
    gmail: seeds.gmail,
    slack: seeds.slack,
    calendar: seeds.calendar,
  });
}

// ---------------------------------------------------------------------------
// The merge.
//
// Pure: no clock, no model, no network, and it mutates nothing it is given. The
// writers run in parallel and this is the only thing that sees all of them, so
// it is also the only place that can notice two of them wrote the same meeting —
// and the only place that must not "fix" it by rewriting either one's words.
// ---------------------------------------------------------------------------

/** One writer's output, tagged with the storyline it was written for. */
export interface StorylineWrite {
  /** `SpineStoryline.id`, or `AMBIENT_ID`. */
  storylineId: string;
  /** The noise pass: belongs to no storyline, and nothing may depend on it. */
  ambient?: boolean;
  seeds: StorylineSeeds;
}

/** The merged company, plus everything the merge could not reconcile. */
export interface NarratedWorld {
  seeds: TwinSeeds;
  warnings: string[];
  ambient: AmbientInventory;
}

/** The storyline id the ambient pass writes under. */
export const AMBIENT_ID = "ambient";

/** Same name, this close together: one meeting two writers both invented. */
const SAME_MEETING_MIN = 120;

/** How many meetings may overlap. Two is a clash worth noticing; five is a bug. */
const MAX_CONCURRENT_EVENTS = 2;

/** Loose identity for prose: "Re: Q3 Renewal!" and "q3 renewal" are one thing. */
function loose(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function eventEnd(e: CalendarEventSeed): number {
  return e.startOffsetMin + eventMinutes(e.durationMin);
}

function overlaps(a: CalendarEventSeed, b: CalendarEventSeed): boolean {
  return a.startOffsetMin < eventEnd(b) && b.startOffsetMin < eventEnd(a);
}

/**
 * The writers finish in whatever order the network decides. Merging in arrival
 * order would give one spine a different company every run — a different one of
 * two duplicate meetings kept, a different thread absorbed into which — so the
 * spine's own order is the one that counts. The noise goes last: a storyline
 * outranks filler for the last free slot in a double-booked hour.
 */
function inSpineOrder(spine: WorldSpine, writes: StorylineWrite[]): StorylineWrite[] {
  const rank = new Map(spine.storylines.map((s, i) => [s.id, i]));
  const at = (w: StorylineWrite) =>
    w.ambient ? spine.storylines.length + 1 : (rank.get(w.storylineId) ?? spine.storylines.length);
  // Code-unit order for the tie, not `localeCompare`: collation comes from
  // whatever ICU the runtime was built with, and a function whose whole job is
  // to be order-independent cannot depend on which Node ran it.
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...writes].sort((a, b) => at(a) - at(b) || byId(a.storylineId, b.storylineId));
}

function gmailKey(m: { fromPersonId: string; minutesAgo: number; body: string }): string {
  return `${m.fromPersonId}|${m.minutesAgo}|${loose(m.body)}`;
}

function slackKey(m: { personId: string; minutesAgo: number; text: string }): string {
  return `${m.personId}|${m.minutesAgo}|${loose(m.text)}`;
}

/** Everyone who said something, and what they said. */
function utterances(seeds: StorylineSeeds): Array<{ personId: string; text: string }> {
  const said: Array<{ personId: string; text: string }> = [];
  for (const thread of seeds.threads ?? []) {
    for (const m of thread.messages ?? []) said.push({ personId: m.fromPersonId, text: m.body });
  }
  for (const channel of seeds.channels ?? []) {
    for (const m of channel.messages ?? []) {
      said.push({ personId: m.personId, text: m.text });
      for (const r of m.threadReplies ?? []) said.push({ personId: r.personId, text: r.text });
    }
  }
  return said;
}

/** Every word one writer produced, for checking a token against. */
function proseOf(seeds: StorylineSeeds): string {
  return [
    ...(seeds.threads ?? []).map((t) => t.subject),
    ...utterances(seeds).map((u) => u.text),
    ...(seeds.events ?? []).flatMap((e) => [e.summary, e.description ?? "", e.location ?? ""]),
  ].join("\n");
}

/**
 * The closest thing to `token` in the prose: "inv 2291" where the spine said
 * "INV-2291". Only ever called once an exact match has already been ruled out,
 * so a writer that spelled it correctly can never be reported. The token's
 * alphanumeric runs are matched in order with any short separator between them,
 * which is how these actually go wrong — case, a space for a hyphen, a dropped
 * currency symbol — and the runs need no escaping because they are alphanumeric
 * by construction.
 */
function nearMiss(prose: string, token: string): string | undefined {
  const runs = token.match(/[A-Za-z0-9]+/g);
  if (!runs) return undefined;
  return new RegExp(runs.join("[^A-Za-z0-9]{0,3}"), "i").exec(prose)?.[0];
}

/**
 * What the writers did to the facts, reported and never repaired. Both checks
 * are exact-match, so a writer that got it right is silent:
 *
 *   - a storyline given a fact that never writes its token. It wrote its own
 *     spelling instead, and a fact spelled two ways is a fact no agent can find;
 *   - somebody outside `knownBy` writing it, which is the leak that who-knows-
 *     what exists to prevent.
 *
 * Neither is repaired here. Code that edits generated writing produces exactly
 * the flat filler this generator exists to avoid, and a "corrected" sentence
 * that nobody wrote reads worse than the contradiction it replaced.
 */
function factWarnings(spine: WorldSpine, ordered: StorylineWrite[]): string[] {
  const out: string[] = [];
  const facts = new Map(
    (spine.facts ?? []).filter((f) => f.token.trim()).map((f) => [f.id, f] as const),
  );

  for (const write of ordered) {
    // The noise is given no facts to keep, so it can hold none wrong.
    if (write.ambient) continue;
    const storyline = spine.storylines.find((s) => s.id === write.storylineId);
    if (!storyline) continue;
    const prose = proseOf(write.seeds);
    for (const id of storyline.factIds ?? []) {
      const fact = facts.get(id);
      if (!fact || prose.includes(fact.token)) continue;
      const variant = nearMiss(prose, fact.token);
      out.push(
        variant
          ? `"${storyline.title}" wrote "${variant}" where ${fact.label} is "${fact.token}". Left as written.`
          : `"${storyline.title}" turns on ${fact.label} ("${fact.token}") and never writes it. Left as written.`,
      );
    }
  }

  for (const fact of facts.values()) {
    if (fact.knownBy.length === 0) continue;
    const knows = new Set(fact.knownBy);
    const leaked = new Set<string>();
    for (const write of ordered) {
      for (const said of utterances(write.seeds)) {
        if (!knows.has(said.personId) && said.text.includes(fact.token)) leaked.add(said.personId);
      }
    }
    for (const person of leaked) {
      out.push(
        `${person} writes ${fact.label} ("${fact.token}") but is not one of the people who know it. Left as written.`,
      );
    }
  }
  return out;
}

/**
 * Every writer's storyline, plus the noise, into one company.
 *
 * Channels come from the SPINE and are never described by a writer, so #ops
 * cannot end up meaning two things; threads and meetings two writers both
 * invented become one; and the double-bookings are capped, because six writers
 * each putting a meeting at 2pm produces a calendar nobody could hold.
 */
export function mergeStorylines(spine: WorldSpine, writes: StorylineWrite[]): NarratedWorld {
  const warnings: string[] = [];
  const ordered = inSpineOrder(spine, writes);
  const titles = new Map(spine.storylines.map((s) => [s.id, s.title]));
  const nameOf = (w: StorylineWrite) =>
    w.ambient ? "the ambient noise" : `"${titles.get(w.storylineId) ?? w.storylineId}"`;

  // --- Gmail: one thread per subject, whoever wrote it -----------------------
  const threads = new Map<string, GmailThreadSeed>();
  const threadFrom = new Map<string, StorylineWrite>();
  for (const write of ordered) {
    (write.seeds.threads ?? []).forEach((thread, i) => {
      const subject = threadSubject(thread.subject);
      // A subjectless thread is still a thread; keying it by its writer stops
      // two of them collapsing into one on the empty string.
      const key = loose(subject) || `${write.storylineId}#${i}`;
      const existing = threads.get(key);
      if (!existing) {
        threads.set(key, {
          subject: thread.subject,
          labels: [...(thread.labels ?? [])],
          participants: [...(thread.participants ?? [])],
          messages: [...(thread.messages ?? [])],
        });
        threadFrom.set(key, write);
        return;
      }
      warnings.push(
        `${nameOf(threadFrom.get(key) ?? write)} and ${nameOf(write)} both wrote a thread ` +
          `called "${subject}"; merged into one.`,
      );
      existing.labels = [...new Set([...existing.labels, ...(thread.labels ?? [])])];
      existing.participants = [
        ...new Set([...existing.participants, ...(thread.participants ?? [])]),
      ];
      const seen = new Set(existing.messages.map(gmailKey));
      for (const m of thread.messages ?? []) {
        if (seen.has(gmailKey(m))) continue;
        seen.add(gmailKey(m));
        existing.messages.push(m);
      }
    });
  }

  // --- Slack: the roster first, then what was posted into it ----------------
  const channels = new Map<string, SlackChannelSeed>();
  const spoken = new Map<string, Set<string>>();
  for (const c of spine.channels ?? []) {
    const name = channelName(c.name);
    if (channels.has(name)) {
      warnings.push(`the spine listed #${name} twice; kept one.`);
      continue;
    }
    // Topic and purpose come from here and only here: a channel is one of the
    // few things every writer sees, so what it is for is not a writer's call.
    channels.set(name, {
      name,
      topic: (c.topic ?? "").trim(),
      purpose: (c.purpose ?? "").trim(),
      members: [...new Set(c.members ?? [])],
      messages: [],
    });
    spoken.set(name, new Set());
  }
  for (const write of ordered) {
    for (const post of write.seeds.channels ?? []) {
      const name = channelName(post.name);
      let channel = channels.get(name);
      if (!channel) {
        // The roster exists so two writers cannot invent #ops and #operations.
        // A writer that went off it anyway keeps its prose — deleting what a
        // model wrote to tidy up a name is the worse trade — but nobody else was
        // told this channel exists, so it is reported rather than absorbed.
        warnings.push(
          `${nameOf(write)} posted in #${name}, which is not on the spine's roster.`,
        );
        channel = { name, topic: "", purpose: "", members: [], messages: [] };
        channels.set(name, channel);
        spoken.set(name, new Set());
      }
      const seen = spoken.get(name) ?? new Set<string>();
      for (const m of post.messages ?? []) {
        const key = slackKey(m);
        if (seen.has(key)) continue;
        seen.add(key);
        channel.messages.push(m);
      }
    }
  }

  // --- Calendar: one of each meeting, and a ceiling on the pile-up ----------
  const events: CalendarEventSeed[] = [];
  const eventFrom: StorylineWrite[] = [];
  for (const write of ordered) {
    for (const event of write.seeds.events ?? []) {
      const twin = events.findIndex(
        (e) =>
          loose(e.summary) === loose(event.summary) &&
          Math.abs(e.startOffsetMin - event.startOffsetMin) <= SAME_MEETING_MIN,
      );
      if (twin >= 0) {
        warnings.push(
          `${nameOf(eventFrom[twin])} and ${nameOf(write)} both scheduled ` +
            `"${event.summary.trim()}"; kept one, with both guest lists.`,
        );
        events[twin] = {
          ...events[twin],
          attendeePersonIds: [
            ...new Set([
              ...(events[twin].attendeePersonIds ?? []),
              ...(event.attendeePersonIds ?? []),
            ]),
          ],
        };
        continue;
      }
      const clashes = events.filter((e) => overlaps(e, event)).length;
      if (clashes >= MAX_CONCURRENT_EVENTS) {
        warnings.push(
          `dropped "${event.summary.trim()}" from ${nameOf(write)}: ${clashes} meetings ` +
            `already sit in that hour, and a calendar stacked deeper than that is unreadable.`,
        );
        continue;
      }
      events.push(event);
      eventFrom.push(write);
    }
  }

  warnings.push(...factWarnings(spine, ordered));

  return {
    seeds: {
      gmail: { threads: [...threads.values()] },
      slack: { channels: [...channels.values()] },
      calendar: { calendars: [...(spine.calendars ?? [])], events },
    },
    warnings,
    // Spelled the way the finished world spells them, so a caller can match on
    // them: `threadSubject` is the same function the Gmail normalizer runs.
    ambient: {
      threads: [...threads.entries()]
        .filter(([key]) => threadFrom.get(key)?.ambient)
        .map(([, t]) => threadSubject(t.subject)),
      events: events.filter((_, i) => eventFrom[i]?.ambient).map((e) => e.summary.trim()),
    },
  };
}

// ---------------------------------------------------------------------------
// The passes
// ---------------------------------------------------------------------------

function rosterBlock(cast: Person[], ownerId: string): string {
  return cast
    .map(
      (p) =>
        `  ${p.id} — ${p.name}, ${p.role} (${p.relationship}${p.id === ownerId ? ", MAILBOX OWNER" : ""})\n` +
        `      voice: ${p.voice}`,
    )
    .join("\n");
}

/** Pass 1: the company and the people in it. */
export async function draftWorld(
  description: string,
  opts: GenerateOptions = {},
): Promise<WorldDraft> {
  const complete = opts.complete ?? completeJSON;
  return complete<WorldDraft>({
    system: SYSTEM,
    prompt:
      `Invent the company described here, and the people an AI assistant would deal with if it ` +
      `worked inside it for one day.\n\n` +
      `DESCRIPTION: ${description}\n\n` +
      // 12 to 18 rather than the handful this used to ask for: a six-person cast
      // gives every thread the same four names on it, and an assistant that can
      // keep six people straight has not been tested on anything.
      `Give 12 to 18 people. Most work at the company — give them its exact name as their org. ` +
      `Include two or three outsiders — a client, a vendor, an auditor, a candidate — each with ` +
      `their own employer's name, because the interesting work crosses the company boundary. One ` +
      `of them is the mailbox owner: someone senior enough to have a busy inbox and a full ` +
      `calendar, and whose job an assistant could plausibly do part of.\n\n` +
      `Include people who are peripheral — someone in a different office, someone on their notice ` +
      `period, someone whose only appearance is a payroll question. A company is not a cast of ` +
      `principals.\n\n` +
      `Every person needs a voice that is theirs and not the others'. One writes in three-word ` +
      `fragments; one sends four paragraphs at 23:40; one is unfailingly polite and never answers ` +
      `the question. That difference is the point — it is what makes the clone read as people ` +
      `rather than as filler.\n\n` +
      `Do not write email addresses, usernames, @-handles or ids anywhere. Names and prose only.`,
    schema: asSchema(WORLD_DRAFT_SCHEMA),
    schemaName: "world_draft",
    model: opts.model,
    effort: "medium",
  });
}

/** The header every writer gets: whose company this is and who is in it. */
function companyBlock(description: string, draft: WorldDraft, cast: Person[], ownerId: string) {
  return (
    `COMPANY: ${draft.business.name} — ${draft.business.industry}, ${draft.business.size} people.\n` +
    `${draft.business.description}\n\n` +
    `THE BRIEF THIS GREW FROM: ${description}\n\n` +
    `ROSTER (refer to people ONLY by these ids):\n${rosterBlock(cast, ownerId)}\n\n`
  );
}

/** The whole spine, small enough that every writer can be handed all of it. */
function spineBlock(spine: WorldSpine): string {
  return (
    `THE WHOLE COMPANY'S PLAN — other writers have the storylines that are not yours:\n` +
    spine.storylines
      .map((s) => `  ${s.id} — ${s.title}: ${s.arc} [${s.castPersonIds.join(", ")}]`)
      .join("\n") +
    `\n\nCHANNELS (the entire Slack; invent none):\n` +
    spine.channels.map((c) => `  #${channelName(c.name)} — ${c.purpose}`).join("\n") +
    `\n\nCALENDARS (use these names exactly):\n` +
    spine.calendars.map((c) => `  ${c.name} — ${c.description}`).join("\n") +
    `\n\nFACTS — true of this company. Spell any you use character for character:\n` +
    spine.facts
      .map((f) => `  ${f.label}: "${f.token}" (known by: ${f.knownBy.join(", ") || "nobody yet"})`)
      .join("\n") +
    `\n\n`
  );
}

const TIME_RULES =
  `TIME: every offset is relative to right now. Gmail and Slack use minutesAgo (bigger = older, ` +
  `never negative). The calendar uses startOffsetMin, negative for meetings that already ` +
  `happened. Spread it over the last few days, not the last hour. Keep offsets consistent with ` +
  `what people say: nobody may write "as we agreed this morning" about something that happens ` +
  `tomorrow.\n\n` +
  `Do not invent ids, email addresses, Slack handles or timestamps. Use the roster ids exactly ` +
  `as written; everything else is attached afterwards.`;

/**
 * Pass 2: the spine — everything the parallel writers must agree on.
 *
 * No prose. The writers cannot see each other, so the only things they can be
 * consistent about are the ones decided here: what the channels are called, what
 * the invoice number is, and who is allowed to know it.
 */
async function draftSpine(
  description: string,
  draft: WorldDraft,
  cast: Person[],
  ownerId: string,
  opts: GenerateOptions,
): Promise<WorldSpine> {
  const complete = opts.complete ?? completeJSON;
  const owner = cast.find((p) => p.id === ownerId) ?? cast[0];
  return complete<WorldSpine>({
    system: SYSTEM,
    prompt:
      companyBlock(description, draft, cast, ownerId) +
      `Plan the last few days of this company — the SHAPE only. No dialogue, no emails, nobody's ` +
      `words. Several writers will each take ONE storyline from this plan and write it across ` +
      `${owner.name}'s inbox, the company Slack and ${owner.name}'s calendar at the same time, ` +
      `without seeing each other's work. This plan is the only thing they share, so everything ` +
      `two of them could contradict each other about has to be settled here.\n\n` +
      `STORYLINES — 4 to 6. Each is one thread of the story with a beginning and an unfinished ` +
      `end: a renewal being negotiated badly, a hire going wrong, a bill nobody will approve, a ` +
      `deadline that has already slipped once. Give each 3 to 6 people from the roster. The ` +
      `mailbox owner is in most of them but not all — an inbox that is entirely about you is not ` +
      `an inbox. Storylines share people and share days; they do not have to relate to each ` +
      `other, because in a real company they mostly do not.\n\n` +
      (opts.channels?.length
        ? `CHANNELS — exactly these, and no others: ${opts.channels
            .map((c) => `#${c}`)
            .join(", ")}. Give each one a topic, a purpose and its members.\n\n`
        : `CHANNELS — 6 to 9 for the whole company, decided here and nowhere else. Two writers ` +
          `left to name their own would give you #ops and #operations and split the story in ` +
          `half. Include the ones a company always has (general, random, a social one) as well ` +
          `as the ones these storylines need.\n\n`) +
      `CALENDARS — ${owner.name}'s own, plus any shared calendar that matters.\n\n` +
      `FACTS — 5 to 10 things that are exactly true: an invoice number, an amount, a date, a ` +
      `room, a version, a name on a contract. Each gets the exact characters every writer must ` +
      `spell, and the people who know it. A fact spelled two ways is a fact no assistant can ` +
      `find, and a fact everybody knows is not worth writing down.`,
    schema: asSchema(WORLD_SPINE_SCHEMA),
    schemaName: "world_spine",
    model: opts.model,
    effort: "medium",
  });
}

/** Pass 3: one storyline, on all three surfaces, by one writer. */
async function writeStoryline(
  description: string,
  draft: WorldDraft,
  cast: Person[],
  ownerId: string,
  spine: WorldSpine,
  storyline: SpineStoryline,
  opts: GenerateOptions,
): Promise<StorylineSeeds> {
  const complete = opts.complete ?? completeJSON;
  const mine = spine.facts.filter((f) => storyline.factIds?.includes(f.id));
  const rosterNames = new Set(spine.channels.map((c) => channelName(c.name)));
  // A storyline that named a channel nobody put on the roster would send its
  // whole Slack half off-roster, so the allowed list falls back to all of them.
  const allowed = (storyline.channels ?? []).map(channelName).filter((c) => rosterNames.has(c));

  return complete<StorylineSeeds>({
    system: SYSTEM,
    prompt:
      companyBlock(description, draft, cast, ownerId) +
      spineBlock(spine) +
      `YOUR STORYLINE — ${storyline.id}: ${storyline.title}\n` +
      `  ${storyline.arc}\n` +
      `  who: ${storyline.castPersonIds.join(", ")}\n` +
      `  channels you may post in: ` +
      `${(allowed.length ? allowed : [...rosterNames]).map((c) => `#${c}`).join(", ")}\n` +
      (mine.length
        ? `  spell these character for character, every time: ` +
          `${mine.map((f) => `"${f.token}"`).join(", ")}\n`
        : "") +
      `\n` +
      `Write ONLY this storyline, and write it in all three places at once: about ` +
      `${Math.max(1, storyline.threadCount)} email threads, about ` +
      `${Math.max(1, storyline.slackMessageCount)} Slack messages, about ` +
      `${Math.max(0, storyline.eventCount)} calendar events. The email people are arguing on is ` +
      `the argument in the channel; the meeting is the one somebody proposed in that thread; a ` +
      `decision made in Slack turns up in an email an hour later. Somebody should contradict ` +
      `themselves across two surfaces, because people do.\n\n` +
      `The other storylines are not yours. Do not write their emails, do not resolve them, and ` +
      `do not have your people discuss them at length — a passing "still no answer on the audit" ` +
      `is fine, a whole thread about it is somebody else's work duplicated.\n\n` +
      `Nobody outside the "known by" list for a fact may write it. That is not a style note: it ` +
      `is the difference between an assistant having to go and find something and being told it.` +
      `\n\n` +
      `GMAIL — real subjects, real quoting habits, real ambiguity. Most threads 2 to 4 messages, ` +
      `at least one long and messy. Some unread, some already handled, at least one that needs an ` +
      `answer today and has not had one.\n\n` +
      `SLACK — short lines, lowercase, half-sentences, the odd :emoji:. Use threadReplies where a ` +
      `conversation actually forked. Not everyone speaks in every channel.\n\n` +
      `CALENDAR — the meetings this storyline caused, on the calendars named above. Standing ` +
      `meetings get a recurrence rule.\n\n` +
      TIME_RULES,
    schema: asSchema(STORYLINE_SEEDS_SCHEMA),
    schemaName: "storyline_seeds",
    model: opts.model,
    effort: opts.effort ?? "high",
    maxTokens: 12000,
  });
}

/**
 * Pass 4: the noise.
 *
 * Cheap, and the most valuable thing in the file. Real inboxes are mostly filler,
 * and filler is this benchmark's actual difficulty knob: retrieval is only hard
 * when there is something to retrieve FROM. A world made only of storylines is a
 * world where every email matters, which no agent has to be good to survive.
 */
async function writeAmbient(
  description: string,
  draft: WorldDraft,
  cast: Person[],
  ownerId: string,
  spine: WorldSpine,
  opts: GenerateOptions,
): Promise<StorylineSeeds> {
  const complete = opts.complete ?? completeJSON;
  return complete<StorylineSeeds>({
    system: SYSTEM,
    prompt:
      companyBlock(description, draft, cast, ownerId) +
      spineBlock(spine) +
      `Write the NOISE — everything in these people's week that belongs to none of the ` +
      `storylines above. The standup nobody reads, a lunch thread, an out-of-office, a vendor ` +
      `newsletter, a payroll reminder, the broken coffee machine, a recruiter nobody asked for, a ` +
      `parking notice, a birthday. 8 to 14 email threads, most of them one or two messages; ` +
      `chatter in the social channels and a line or two in the working ones; the recurring ` +
      `meetings a company has whether or not anything is happening.\n\n` +
      `None of it advances a storyline and none of it contradicts one, and nobody in it writes ` +
      `one of the facts above — those belong to the storylines that turn on them, and a number ` +
      `an assistant can find in the lunch thread is a number it never had to go and look for. ` +
      `The noise must not be the only place a fact appears either: nothing here is load-bearing, ` +
      `and something that needs finding must not be findable only here.\n\n` +
      `This is what a real inbox is mostly made of, and it is what makes finding the thing that ` +
      `matters actually hard. Write it as flatly and as ordinarily as the real thing.\n\n` +
      TIME_RULES,
    schema: asSchema(STORYLINE_SEEDS_SCHEMA),
    schemaName: "ambient_seeds",
    model: opts.model,
    effort: "low",
    maxTokens: 12000,
  });
}

/**
 * The lists the spine promises, present even when the model sent three of the
 * four.
 *
 * `completeJSON` parses loosely on purpose, because providers soft-honour
 * structured output, so a spine can arrive without its `facts` or with a
 * storyline that lost its `castPersonIds`. Every prompt below reads all of them
 * — one missing array took out the spine block, and therefore all five writers
 * and the noise, with "Cannot read properties of undefined". That is the exact
 * whole-company failure splitting the call up was supposed to end, and it also
 * meant the sentence written for an empty plan could never be the one a user
 * saw. Missing is empty here, and the merge's own guards stay where they are
 * because it is exported and takes a spine from anywhere.
 */
function usableSpine(spine: WorldSpine): WorldSpine {
  return {
    storylines: (spine.storylines ?? []).map((s) => ({
      ...s,
      castPersonIds: s.castPersonIds ?? [],
      channels: s.channels ?? [],
      factIds: s.factIds ?? [],
    })),
    channels: (spine.channels ?? []).map((c) => ({
      ...c,
      name: c.name ?? "",
      members: c.members ?? [],
    })),
    calendars: spine.calendars ?? [],
    facts: (spine.facts ?? []).map((f) => ({
      ...f,
      token: f.token ?? "",
      knownBy: f.knownBy ?? [],
    })),
  };
}

/**
 * Every channel the caller pinned, present whether or not the spine listed it.
 *
 * A day's beats post into "#ops" by name, so a channel the spine forgot is a
 * beat with nowhere to land — and `canonicalize` rebuilds the world's channel
 * list from the merged Slack seed, so a channel missing here is missing from the
 * world.
 */
function pinRoster(spine: WorldSpine, pinned: string[] | undefined): WorldSpine {
  if (!pinned?.length) return spine;
  const have = new Set(spine.channels.map((c) => channelName(c.name)));
  const channels = [...spine.channels];
  for (const raw of pinned) {
    const name = channelName(raw);
    if (have.has(name)) continue;
    have.add(name);
    channels.push({ name, topic: "", purpose: "", members: [] });
  }
  return channels.length === spine.channels.length ? spine : { ...spine, channels };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Passes 2 to 4 and the merge: the from-scratch narrative path.
 *
 * The writers run at once because they have nothing to say to each other — the
 * spine already said it — and because five sequential 12k-token calls is a
 * minute of somebody's afternoon. `allSettled`, not `all`: the whole point of
 * splitting the call up is that a bad response costs one storyline instead of
 * the company, and `all` would throw that away on the first rejection.
 */
export async function narrateByStoryline(
  description: string,
  draft: WorldDraft,
  cast: Person[],
  ownerId: string,
  opts: GenerateOptions = {},
): Promise<NarratedWorld> {
  const say = opts.say ?? (() => {});
  const spine = pinRoster(
    usableSpine(await draftSpine(description, draft, cast, ownerId, opts)),
    opts.channels,
  );
  if (spine.storylines.length === 0) {
    throw new Error(
      `The plan for "${draft.business.name}" came back with no storylines, so there is nothing ` +
        `to write. Try again.`,
    );
  }
  say(
    `${spine.storylines.length} storylines, ${spine.channels.length} channels and ` +
      `${spine.facts.length} facts to keep straight`,
  );

  const jobs: Array<Promise<StorylineWrite>> = spine.storylines.map(async (storyline) => {
    const seeds = await writeStoryline(
      description,
      draft,
      cast,
      ownerId,
      spine,
      storyline,
      opts,
    );
    say(
      `wrote "${storyline.title}": ${seeds.threads?.length ?? 0} threads, ` +
        `${seeds.events?.length ?? 0} events`,
    );
    return { storylineId: storyline.id, seeds };
  });
  jobs.push(
    (async () => {
      const seeds = await writeAmbient(description, draft, cast, ownerId, spine, opts);
      say(`wrote the ambient noise: ${seeds.threads?.length ?? 0} threads`);
      return { storylineId: AMBIENT_ID, ambient: true, seeds };
    })(),
  );

  const settled = await Promise.allSettled(jobs);
  const written: StorylineWrite[] = [];
  const lost: string[] = [];
  settled.forEach((result, i) => {
    const what =
      i < spine.storylines.length ? `"${spine.storylines[i].title}"` : "the ambient noise";
    if (result.status === "fulfilled") {
      written.push(result.value);
      return;
    }
    // Named, not swallowed: a company that is quietly one storyline short is a
    // benchmark whose difficulty nobody can account for.
    lost.push(`${what} was never written: ${reason(result.reason)}`);
    say(`lost ${what}: ${reason(result.reason)}`);
  });
  if (written.length === 0) {
    throw new Error(`Every writer failed for "${draft.business.name}". ${lost.join("; ")}`);
  }

  const merged = mergeStorylines(spine, written);
  // Said, not merely counted. `say` is the only channel this has to the person
  // who asked for a company, and a contradiction nobody reads is the same as no
  // contradiction. The lost writers are already spoken above.
  for (const warning of merged.warnings) say(warning);
  return { ...merged, warnings: [...lost, ...merged.warnings] };
}

/** One description in, one coherent fake company out. */
export async function generateWorld(
  description: string,
  opts: GenerateOptions = {},
): Promise<GeneratedWorld> {
  const say = opts.say ?? (() => {});

  say("inventing the company and its people");
  const draft = await draftWorld(description, opts);

  // The cast is assembled before the narrative passes so the models write
  // against the real ids rather than against names to be matched on later.
  const cast = assembleCast(draft);
  const named = draft.mailboxOwnerName?.trim().toLowerCase();
  const ownerId = (cast.find((p) => p.name.toLowerCase() === named) ?? cast[0]).id;

  say(`planning the week for ${cast.length} people`);
  const narrated = await narrateByStoryline(description, draft, cast, ownerId, opts);

  const generated = assembleWorld(description, draft, narrated.seeds, { now: opts.now });
  say(
    `${generated.world.business.name}: ${generated.gmail.threads.length} threads, ` +
      `${generated.slack.channels.length} channels, ${generated.calendar.events.length} events` +
      (narrated.warnings.length
        ? `, ${narrated.warnings.length} warning${narrated.warnings.length === 1 ? "" : "s"}`
        : ""),
  );
  const ambient = narrated.ambient;
  return {
    ...generated,
    ...(narrated.warnings.length ? { warnings: narrated.warnings } : {}),
    ...(ambient.threads.length || ambient.events.length ? { ambient } : {}),
  };
}
