import type { ChannelSeed, Person, WorldSeed } from "@sonata/core";
import { completeJSON, type CompleteJSON, type Effort } from "./llm";
import {
  asSchema,
  TWIN_SEEDS_SCHEMA,
  WORLD_DRAFT_SCHEMA,
  type CalendarSeed,
  type GmailSeed,
  type SlackSeed,
  type TwinSeeds,
  type WorldDraft,
} from "./schema";

// ---------------------------------------------------------------------------
// "a 12-person fintech, the week before an audit" -> one coherent fake company,
// projected into Gmail, Slack and a calendar with the SAME cast.
//
// Two model passes, and only two:
//   1. the company and its people — who exists, what they do, how they write;
//   2. one narrative pass over all three surfaces at once, so the story agrees
//      with itself (the thread the auditor started is the thing #finance is
//      arguing about, and the people in the 2pm are the people on the thread).
//      Writing the surfaces separately is what makes a clone feel like three
//      unrelated fixtures, so it is deliberately not three calls.
//
// The model writes PROSE ONLY. Person ids, email addresses, Slack user and
// channel ids, calendar ids, channel membership, threading and every timestamp
// are assembled below, in code. This is the same discipline the Gmail scenario
// generator runs on and it is why any of this is testable: given a fixed draft,
// `assembleWorld` is a pure function with one right answer.
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
      subject: thread.subject.trim().replace(/^\s*(re|fwd?)\s*:\s*/i, ""),
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
        durationMin: Math.min(600, Math.max(5, Math.round(e.durationMin) || 30)),
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
// The two passes
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
      `Invent the company described here, and the handful of people an AI assistant would deal ` +
      `with if it worked inside it for one day.\n\n` +
      `DESCRIPTION: ${description}\n\n` +
      `Give 6 to 10 people. Most work at the company — give them its exact name as their org. ` +
      `Include at least one outsider — a client, a vendor, an auditor, a candidate — with their ` +
      `own employer's name, because the interesting work crosses the company boundary. One of ` +
      `them is the mailbox owner: someone senior enough to have a busy inbox and a full calendar, ` +
      `and whose job an assistant could plausibly do part of.\n\n` +
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

/** Pass 2: the story, on all three surfaces at once. */
export async function narrateSurfaces(
  description: string,
  draft: WorldDraft,
  cast: Person[],
  ownerId: string,
  opts: GenerateOptions = {},
): Promise<TwinSeeds> {
  const complete = opts.complete ?? completeJSON;
  const owner = cast.find((p) => p.id === ownerId) ?? cast[0];
  return complete<TwinSeeds>({
    system: SYSTEM,
    prompt:
      `COMPANY: ${draft.business.name} — ${draft.business.industry}, ${draft.business.size} people.\n` +
      `${draft.business.description}\n\n` +
      `THE BRIEF THIS GREW FROM: ${description}\n\n` +
      `ROSTER (refer to people ONLY by these ids):\n${rosterBlock(cast, ownerId)}\n\n` +
      `You are writing the last few days of this company as they appear in three places at once: ` +
      `${owner.name}'s inbox, the company Slack, and ${owner.name}'s calendar. This is one story, ` +
      `not three. The thread that is worrying people in email is the thread #channel is arguing ` +
      `about; the meeting on the calendar is the meeting someone proposed in that thread; a ` +
      `decision made in Slack shows up in an email an hour later. Someone should contradict ` +
      `themselves across two surfaces, because people do.\n\n` +
      `GMAIL — 5 to 8 threads. Most 2 to 4 messages, at least one long and messy. Real subjects, ` +
      `real quoting habits, real ambiguity. Some are unread; some are already handled; at least ` +
      `one needs an answer today and nobody has given one.\n\n` +
      (opts.channels?.length
        ? `SLACK — write in exactly these channels and invent no others: ` +
          `${opts.channels.map((c) => `#${c}`).join(", ")}. Short lines, lowercase, ` +
          `half-sentences, the odd :emoji:. Use threads where a conversation actually forked. ` +
          `Not everyone speaks in every channel.\n\n`
        : `SLACK — 3 to 5 channels. Short lines, lowercase, half-sentences, the odd :emoji:. Use ` +
          `threads where a conversation actually forked. Not everyone speaks in every channel.\n\n`) +
      `CALENDAR — ${owner.name}'s own calendar plus any shared one that matters. 6 to 12 events ` +
      `spread from about two days ago to two days ahead: standing meetings with a recurrence rule, ` +
      `one-off meetings the emails reference, and at least one clash worth noticing.\n\n` +
      `TIME: every offset is relative to right now. Gmail and Slack use minutesAgo (bigger = ` +
      `older, never negative). The calendar uses startOffsetMin, negative for meetings that ` +
      `already happened. Keep offsets consistent with what people say: nobody may write "as we ` +
      `agreed this morning" about something that happens tomorrow.\n\n` +
      `Do not invent ids, email addresses, Slack handles or timestamps. Use the roster ids exactly ` +
      `as written above; everything else is attached afterwards.`,
    schema: asSchema(TWIN_SEEDS_SCHEMA),
    schemaName: "twin_seeds",
    model: opts.model,
    effort: opts.effort ?? "high",
    maxTokens: 32000,
  });
}

/** One description in, one coherent fake company out. */
export async function generateWorld(
  description: string,
  opts: GenerateOptions = {},
): Promise<GeneratedWorld> {
  const say = opts.say ?? (() => {});

  say("inventing the company and its people");
  const draft = await draftWorld(description, opts);

  // The cast is assembled before the narrative pass so the model writes against
  // the real ids rather than against names it would then have to be matched on.
  const cast = assembleCast(draft);
  const named = draft.mailboxOwnerName?.trim().toLowerCase();
  const ownerId = (cast.find((p) => p.name.toLowerCase() === named) ?? cast[0]).id;

  say(`writing the week across three surfaces for ${cast.length} people`);
  const seeds = await narrateSurfaces(description, draft, cast, ownerId, opts);

  const generated = assembleWorld(description, draft, seeds, { now: opts.now });
  say(
    `${generated.world.business.name}: ${generated.gmail.threads.length} threads, ` +
      `${generated.slack.channels.length} channels, ${generated.calendar.events.length} events`,
  );
  return generated;
}
