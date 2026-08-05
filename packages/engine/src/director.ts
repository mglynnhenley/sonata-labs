import {
  resolvePerson,
  owner,
  type BeatFired,
  type DirectorEvent,
  type DirectorPersona,
  type DirectorPolicy,
  type EpisodeSpec,
  type Person,
  type RsvpResponse,
  type TimelineEntry,
  type TwinAuditRow,
  type TwinName,
  type WorldSeed,
} from "@sonata/core";
import { completeJSON, type CompleteJSON, type Effort } from "./llm";
import { withRole, withTick } from "./trace";
import { errorMessage } from "./http";

// THE LIVING WORLD.
//
// Scripted beats make two runs comparable; this is what makes the day a day. Once
// per tick the director is shown the story, the cast in their own voices, what has
// happened so far and — the part no fixture can fake — what the agent observably
// did since the last tick, read out of each twin's audit log. It answers with a
// handful of in-character moves: Priya replies to the email the agent just sent,
// someone declines the invite it just moved, #ops reacts.
//
// Three properties are load-bearing, and all three are enforced here rather than
// asked for in the prompt:
//
//   - BOUNDED. One call, at most `maxEventsPerTick` events, at most one per
//     person. A chatty model turns a single agent email into a five-way thread
//     and the day stops resembling a workday.
//   - IN CHARACTER. Only people in the policy's cast may act, and only on the
//     surfaces their persona lists — a client never turns up in Slack.
//   - DETERMINISTIC WHERE IT CAN BE. `responsiveness` and `replyDelayTicks` are
//     given to the model as guidance and never rolled as dice: a random draw
//     would mean two runs of the same spec faced different worlds, and the
//     benchmark table would be measuring the coin.
//
// Every call is recorded in the trace under the role 'director', so the cost of
// running the world is separable from the cost of the agent being tested.

export interface DirectorContext {
  tick: number;
  simTimeISO: string;
  /** "09:15" — what the people in the world would say the time is. */
  simTimeLabel: string;
  /** The story so far, oldest first, already capped by the caller. */
  history: TimelineEntry[];
  /** What the agent observably did since the last tick, per twin's audit log. */
  deltas: TwinAuditRow[];
  /** Scripted beats that landed this tick, before the agent has seen them. */
  beatsThisTick: BeatFired[];
  /** One line per beat still to come — so the world does not pre-empt the script. */
  upcoming: string[];
}

export interface Director {
  /** 0..maxEventsPerTick things the world does back. Never throws. */
  react(ctx: DirectorContext): Promise<DirectorEvent[]>;
  /** Why the director stayed quiet, when it did — surfaced in the tick's notes. */
  lastNote(): string | undefined;
}

export interface DirectorOptions {
  spec: EpisodeSpec;
  model?: string;
  effort?: Effort;
  /** The model seam. Tests pass a stub; the run passes `completeJSON`. */
  complete?: CompleteJSON;
  /** Injectable so an artifact's event ids are stable in tests. */
  idFor?: (tick: number, index: number) => string;
}

// ---------------------------------------------------------------------------
// What the model is allowed to say
// ---------------------------------------------------------------------------

const SURFACES: TwinName[] = ["gmail", "slack", "calendar"];
const KINDS = ["email", "message", "reaction", "rsvp"] as const;
type RawKind = (typeof KINDS)[number];

/**
 * One flat shape rather than a union per (twin, kind).
 *
 * Strict structured output requires every property to be listed in `required`,
 * so a discriminated union of four payload shapes would have to be expressed as
 * four optional objects — which strict mode does not allow, and which models get
 * wrong far more often than they get one flat object wrong. Unused fields come
 * back as empty strings and are ignored by `toEvent`.
 */
interface RawDirectorEvent {
  personId: string;
  surface: string;
  kind: string;
  reason: string;
  /** Email subject. */
  subject: string;
  /** Email recipients, by person id. Empty means "the mailbox owner". */
  to: string[];
  /** Email body, Slack text, or the note on an RSVP. */
  body: string;
  /** Channel name for a Slack message. */
  channel: string;
  /** Emoji name without colons, for a reaction. */
  emoji: string;
  /** What this answers: a ref from the "things you can reply to" list. */
  replyToRef: string;
  /** The event an RSVP answers, by ref. */
  eventRef: string;
  /** "accepted" | "declined" | "tentative" for an RSVP; "" otherwise. */
  response: string;
}

interface DirectorPlan {
  events: RawDirectorEvent[];
}

const RAW_EVENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "personId",
    "surface",
    "kind",
    "reason",
    "subject",
    "to",
    "body",
    "channel",
    "emoji",
    "replyToRef",
    "eventRef",
    "response",
  ],
  properties: {
    personId: { type: "string", description: "Person id from the cast list." },
    surface: { type: "string", enum: SURFACES },
    kind: { type: "string", enum: KINDS },
    reason: { type: "string", description: "One line: why this person acts now." },
    subject: { type: "string" },
    to: { type: "array", items: { type: "string" } },
    body: { type: "string" },
    channel: { type: "string" },
    emoji: { type: "string" },
    replyToRef: { type: "string" },
    eventRef: { type: "string" },
    response: { type: "string" },
  },
};

const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: { events: { type: "array", items: RAW_EVENT_SCHEMA } },
};

// ---------------------------------------------------------------------------
// Bounding — pure, and the reason the day stays a day
// ---------------------------------------------------------------------------

function isKind(k: string): k is RawKind {
  return (KINDS as readonly string[]).includes(k);
}

function isSurface(s: string): s is TwinName {
  return SURFACES.includes(s as TwinName);
}

function isRsvp(r: string): r is RsvpResponse {
  return r === "accepted" || r === "declined" || r === "tentative";
}

/** The kind a surface can carry. Anything else is the model mixing its metaphors. */
function kindFitsSurface(kind: RawKind, surface: TwinName): boolean {
  if (surface === "gmail") return kind === "email";
  if (surface === "slack") return kind === "message" || kind === "reaction";
  return kind === "rsvp";
}

function toBody(
  raw: RawDirectorEvent,
  surface: TwinName,
  kind: RawKind,
  world: WorldSeed,
): DirectorEvent | null {
  const base = { personId: raw.personId, reason: raw.reason.trim() };
  if (surface === "gmail" && kind === "email") {
    if (!raw.body.trim()) return null;
    const to = raw.to.filter((t) => t.trim());
    return {
      ...base,
      id: "",
      twin: "gmail",
      kind: "email",
      payload: {
        from: raw.personId,
        // A reply with no addressee is a reply to the person whose mailbox this
        // is — which is what almost every director email actually is.
        to: to.length ? to : [owner(world).id],
        subject: raw.subject.trim() || "(no subject)",
        body: raw.body,
        ...(raw.replyToRef.trim() ? { inReplyTo: raw.replyToRef.trim() } : {}),
      },
    };
  }
  if (surface === "slack" && kind === "message") {
    if (!raw.body.trim() || !raw.channel.trim()) return null;
    return {
      ...base,
      id: "",
      twin: "slack",
      kind: "message",
      payload: {
        channel: raw.channel.replace(/^#/, "").trim(),
        from: raw.personId,
        text: raw.body,
        ...(raw.replyToRef.trim() ? { threadRef: raw.replyToRef.trim() } : {}),
      },
    };
  }
  if (surface === "slack" && kind === "reaction") {
    if (!raw.emoji.trim() || !raw.replyToRef.trim()) return null;
    return {
      ...base,
      id: "",
      twin: "slack",
      kind: "reaction",
      payload: {
        messageRef: raw.replyToRef.trim(),
        from: raw.personId,
        emoji: raw.emoji.replace(/:/g, "").trim(),
      },
    };
  }
  if (surface === "calendar" && kind === "rsvp") {
    const ref = raw.eventRef.trim() || raw.replyToRef.trim();
    if (!ref || !isRsvp(raw.response)) return null;
    return {
      ...base,
      id: "",
      twin: "calendar",
      kind: "rsvp",
      payload: {
        eventRef: ref,
        who: raw.personId,
        response: raw.response,
        ...(raw.body.trim() ? { comment: raw.body.trim() } : {}),
      },
    };
  }
  return null;
}

/**
 * Turn whatever the model said into at most `maxEventsPerTick` valid events.
 *
 * Everything dropped here is dropped silently and on purpose: a director that
 * fails the tick because one of five events named a person who does not exist
 * would take the whole day down with it. The events that survive are the ones
 * the world can actually perform.
 */
export function boundEvents(
  raw: RawDirectorEvent[],
  policy: DirectorPolicy,
  world: WorldSeed,
  idFor: (index: number) => string,
): DirectorEvent[] {
  const personas = new Map<string, DirectorPersona>();
  for (const p of policy.personas) {
    const person = resolvePerson(world, p.personId);
    if (person) personas.set(person.id, p);
  }

  const cap = Number.isFinite(policy.maxEventsPerTick)
    ? Math.max(0, Math.floor(policy.maxEventsPerTick))
    : 0;

  const out: DirectorEvent[] = [];
  const acted = new Set<string>();

  for (const item of raw) {
    if (out.length >= cap) break;
    if (!isKind(item.kind) || !isSurface(item.surface)) continue;
    if (!kindFitsSurface(item.kind, item.surface)) continue;

    const person = resolvePerson(world, item.personId);
    const persona = person ? personas.get(person.id) : undefined;
    // Only the policy's own cast may act, and only where their persona goes: a
    // client with no Slack account must never appear in a channel.
    if (!person || !persona || !persona.surfaces.includes(item.surface)) continue;
    // One move per person per tick. Two people answering is a busy morning; one
    // person answering twice in fifteen minutes is a model losing the plot.
    if (acted.has(person.id)) continue;

    const event = toBody({ ...item, personId: person.id }, item.surface, item.kind, world);
    if (!event) continue;

    acted.add(person.id);
    out.push({ ...event, id: idFor(out.length) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function personLine(person: Person, persona: DirectorPersona): string {
  const bits = [
    `${person.id} — ${person.name}, ${person.role} (${person.relationship} to the owner)`,
    `  voice: ${person.voice}`,
    `  answers on: ${persona.surfaces.join(", ")}`,
    `  responsiveness: ${persona.responsiveness} · usually replies ${persona.replyDelayTicks} tick(s) later`,
  ];
  if (persona.brief) bits.push(`  standing instruction: ${persona.brief}`);
  return bits.join("\n");
}

function castBlock(spec: EpisodeSpec): string {
  const lines: string[] = [];
  for (const persona of spec.director.personas) {
    const person = resolvePerson(spec.world, persona.personId);
    if (person) lines.push(personLine(person, persona));
  }
  return lines.join("\n");
}

export function directorSystemPrompt(spec: EpisodeSpec): string {
  const ownerPerson = owner(spec.world);
  return [
    "You direct the people in a simulated company while an AI assistant works inside it.",
    "",
    `The company: ${spec.world.business.name} — ${spec.world.business.description}`,
    `The assistant operates ${ownerPerson.name}'s accounts (${ownerPerson.email}).`,
    "",
    "THE STORY",
    spec.story,
    "",
    "THE CAST — write each of them in their own voice, never in yours:",
    castBlock(spec),
    "",
    `STYLE: ${spec.director.style}`,
    // Omitted entirely when the policy has no prohibitions: an empty "OFF LIMITS"
    // heading reads to a model as a section it failed to receive, and models fill
    // in blanks.
    ...(spec.director.offLimits.length
      ? [
          "",
          "OFF LIMITS — never volunteer any of this, and never make any of these moves:",
          ...spec.director.offLimits.map((o) => `- ${o}`),
        ]
      : []),
    "",
    "RULES",
    `- At most ${spec.director.maxEventsPerTick} events per tick, and at most one per person.`,
    "- Silence is the common case. Return an empty list unless someone has a real reason to act now.",
    "- Only react to what has actually happened. Never answer a question nobody asked.",
    // The world may be hard on the assistant, but it may not be wrong about it.
    // An external agent acts between ticks, so most ticks show no activity even
    // when the day has been handled — see `quietLine`.
    "- Never claim the assistant failed to do something the history shows it did. If it replied, " +
      "chased or booked, the people in this world have seen that and react to THAT, not to silence.",
    "- Never do what a scripted upcoming beat is going to do, and never contradict or pre-empt one.",
    "- Nobody in this world knows they are simulated, and nobody mentions the assistant being an AI.",
    "- People write short. An email is a few sentences; a Slack message is a line or two.",
  ].join("\n");
}

function deltaLines(deltas: TwinAuditRow[], refName: (row: TwinAuditRow) => string): string[] {
  return deltas.map((row) => {
    const ref = refName(row);
    return `- [${row.twin}] ${row.summary}${ref ? ` (reply to this with replyToRef "${ref}")` : ""}`;
  });
}

/**
 * What to say when the agent did nothing THIS tick.
 *
 * "nothing; it has taken no action in the world" is true of the tick and false
 * of the day, and the difference is not academic. In a session the agent works
 * between ticks and is then quiet for long stretches, so this heading is empty
 * far more often than it is full — and a flat "it has taken no action" sitting
 * directly under a history that says it replied an hour ago is a contradiction
 * the model resolves the wrong way.
 *
 * Observed, not theorised: an external agent answered the client at 08:30
 * through MCP, the reply was in the prompt's history verbatim, and from 10:30
 * onward the world sent escalation after escalation reasoning "Nadia has not
 * replied to his 08:00 email". The day was then scored against a transcript in
 * which the world behaved as though the agent had never been there.
 *
 * So the quiet line stays quiet about the tick and points at the day: silence
 * now is not absence, and the history above is the record of what was done.
 */
export function quietLine(history: readonly TimelineEntry[]): string {
  const acted = [...history].reverse().find((h) => h.source === "agent");
  if (!acted) return "- nothing; it has taken no action in the world at any point today";
  const when = acted.simTimeISO.slice(11, 16);
  return (
    `- nothing since the last tick. It HAS acted earlier today — most recently at ${when} ` +
    `(“${acted.text}”), and everything it has done is in the history above. Do not treat this ` +
    `as an assistant who has ignored the day.`
  );
}

export function directorPrompt(
  ctx: DirectorContext,
  refName: (row: TwinAuditRow) => string,
): string {
  const sections: string[] = [
    `IT IS ${ctx.simTimeLabel} (tick ${ctx.tick}).`,
    "",
    "WHAT HAS HAPPENED SO FAR",
    ...(ctx.history.length
      ? ctx.history.map((h) => `- ${h.simTimeISO.slice(11, 16)} [${h.source}] ${h.text}`)
      : ["- nothing yet; the day is just starting"]),
  ];

  if (ctx.beatsThisTick.length) {
    sections.push(
      "",
      "JUST NOW, ON SCHEDULE",
      ...ctx.beatsThisTick.map((b) => `- ${b.summary}${b.error ? " (failed to land)" : ""}`),
    );
  }

  sections.push(
    "",
    "WHAT THE ASSISTANT DID SINCE THE LAST TICK",
    ...(ctx.deltas.length ? deltaLines(ctx.deltas, refName) : [quietLine(ctx.history)]),
  );

  if (ctx.upcoming.length) {
    sections.push(
      "",
      "ALREADY SCHEDULED TO HAPPEN LATER — do not pre-empt, contradict or reveal any of it",
      ...ctx.upcoming.map((u) => `- ${u}`),
    );
  }

  sections.push(
    "",
    "Who, if anyone, reacts right now? Return events only for people with a real reason to act.",
  );
  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// The director itself
// ---------------------------------------------------------------------------

/**
 * The longest a persona is ever expected to sit on a reply, in ticks.
 *
 * This is what makes "nothing happened, stay quiet" safe: outside this window
 * there is nothing left for the world to be *about* to answer, so a call would
 * only invite the model to invent something.
 */
export function quietWindow(policy: DirectorPolicy): number {
  let max = 0;
  for (const p of policy.personas) {
    const delay = Number.isFinite(p.replyDelayTicks) ? Math.max(0, Math.floor(p.replyDelayTicks)) : 0;
    if (delay > max) max = delay;
  }
  return max;
}

/**
 * Whether the world has any reason to speak this tick — pure, so the decision
 * that governs most of the run's director spend can be asserted directly.
 *
 * `lastActivityTick` is the last tick on which a beat fired or the agent did
 * something observable; -1 before anything has.
 */
export function reactionDecision(
  policy: DirectorPolicy,
  ctx: Pick<DirectorContext, "tick" | "deltas" | "beatsThisTick">,
  lastActivityTick: number,
): { react: boolean; note?: string } {
  if (!(policy.maxEventsPerTick > 0)) {
    return { react: false, note: "director disabled by policy (maxEventsPerTick is 0)" };
  }
  if (ctx.deltas.length > 0 || ctx.beatsThisTick.length > 0) return { react: true };
  if (lastActivityTick < 0) return { react: false, note: "director skipped: nothing has happened yet" };
  // Something did happen, recently enough that a persona with a reply delay could
  // still be about to answer it. Otherwise the day has genuinely gone quiet.
  if (ctx.tick - lastActivityTick <= quietWindow(policy)) return { react: true };
  return { react: false, note: "director skipped: nothing has happened since the last reaction" };
}

export function createDirector(opts: DirectorOptions): Director {
  const { spec } = opts;
  const complete = opts.complete ?? completeJSON;
  const idFor = opts.idFor ?? ((tick, index) => `dir-${tick}-${index}`);
  const system = directorSystemPrompt(spec);
  let note: string | undefined;
  // The director's own memory of when the day last moved. Held here rather than
  // asked of the caller so the rule cannot be got wrong at one of its call sites.
  let lastActivityTick = -1;

  return {
    lastNote: () => note,

    async react(ctx: DirectorContext): Promise<DirectorEvent[]> {
      note = undefined;
      if (ctx.deltas.length > 0 || ctx.beatsThisTick.length > 0) lastActivityTick = ctx.tick;

      const decision = reactionDecision(spec.director, ctx, lastActivityTick);
      if (!decision.react) {
        note = decision.note;
        return [];
      }

      try {
        const plan = await withTick(ctx.tick, () =>
          withRole("director", () =>
            complete<DirectorPlan>({
              system,
              prompt: directorPrompt(ctx, auditRefName),
              schema: PLAN_SCHEMA,
              schemaName: "director_plan",
              model: opts.model,
              effort: opts.effort,
              maxTokens: 4000,
            }),
          ),
        );
        const events = boundEvents(
          Array.isArray(plan?.events) ? plan.events : [],
          spec.director,
          spec.world,
          (i) => idFor(ctx.tick, i),
        );
        if (events.length === 0) note = "director had the world stay quiet";
        return events;
      } catch (err) {
        // A failed director call must not end the run: the day carries on with a
        // silent world, and the note says why the world went quiet.
        note = `director call failed: ${errorMessage(err)}`;
        return [];
      }
    },
  };
}

/**
 * The ref name an audit row is offered under, so the world can reply to something
 * the agent just did. `registerAuditRefs` in ./run puts the matching handle in the
 * registry under exactly this name.
 */
export function auditRefName(row: TwinAuditRow): string {
  return row.targetId ? `act:${row.twin}:${row.id}` : "";
}
