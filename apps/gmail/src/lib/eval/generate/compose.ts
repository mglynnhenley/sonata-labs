import { bindContact } from "../generate";
import { completeJSON } from "../llm";
import { withRole } from "../trace";
import type { Anchor, Contact, Exemplar, Fixture, FixtureMessage } from "../types";
import type { Approach, Stage, StageCtx, ThreadContext, Timeline } from "./types";

// ---------------------------------------------------------------------------
// Stage 6 — write the prose. Everything the earlier stages found arrives here as
// prompt material: what the anchor thread is actually about (3), when everything
// really happened (4), and the angle chosen for it (5). Nothing is re-derived.
//
// The model writes ONLY subject + body text. Labels, backdating, threading and
// address binding are assembled in code below — that is the load-bearing property
// of this design: a model that could set its own labels or dates could quietly
// make a scenario easier than the scenario declares it to be.
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface ComposeInput {
  /** The real thread being continued, or null when nothing in the mailbox qualified. */
  anchor: Anchor | null;
  /** Stage 3's reading of that thread. Null when there was no anchor to read. */
  thread: ThreadContext | null;
  timeline: Timeline;
  approach: Approach;
  exemplars: Exemplar[];
}

export interface Composed {
  fixture: Fixture;
  contact: Contact;
}

const FIXTURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["slots"],
  properties: {
    slots: {
      type: "array",
      description: "One entry per requested slot, in the same order, with matching ids.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "subject", "text"],
        properties: {
          id: { type: "string", description: "The slot id this fills." },
          subject: { type: "string" },
          text: {
            type: "string",
            description: "Plain-text email body. No markdown, no signature block boilerplate.",
          },
        },
      },
    },
  },
} as const;

interface GeneratedSlot {
  id: string;
  subject: string;
  text: string;
}

function addr(name: string, email: string): string {
  return `${name} <${email}>`;
}

function reSubject(parent: string): string {
  const base = parent.replace(/^\s*(re|fwd?)\s*:\s*/i, "").trim();
  return `Re: ${base}`;
}

/** Whole days between two instants. Prose only — scheduling uses `SlotTime.at`. */
function daysBetween(from: number, to: number): number {
  return Math.max(0, Math.round((to - from) / DAY));
}

/**
 * Degraded phrasing for a slot the timeline didn't cover. The timeline is meant to
 * carry every slot; this exists so a thin mailbox still produces a fixture rather
 * than failing the run, and it reads as the old unanchored offset because that is
 * exactly what it is.
 */
function offsetPhrase(minutesAgo: number): string {
  return minutesAgo >= 1440
    ? `${Math.round(minutesAgo / 1440)} day(s) ago`
    : `${minutesAgo} minutes ago`;
}

/**
 * Generate a concrete fixture for the scenario, in the mailbox's own voice.
 * Returns the fixture plus the contact the scenario was bound to.
 */
export async function composeFixture(
  input: ComposeInput,
  ctx: StageCtx,
): Promise<Composed> {
  const { anchor, thread, timeline, approach, exemplars } = input;
  const { scenario, profile } = ctx;
  const contact = bindContact(scenario, profile, anchor);
  const useAnchor = scenario.preferAnchor && !!anchor;

  const timeBySlot = new Map(timeline.slots.map((s) => [s.slotId, s]));

  const exemplarText = exemplars
    .map(
      (e, i) =>
        `--- Example ${i + 1} (from ${e.fromAddr}) ---\nSubject: ${e.subject}\n${e.body}`,
    )
    .join("\n\n");

  const slotSpec = scenario.slots
    .map((s) => {
      const who =
        s.sender === "contact"
          ? `${contact.name} <${contact.email}>`
          : `${profile.ownerName} <${profile.ownerEmail}>`;
      const at = timeBySlot.get(s.id);
      const when = at ? at.phrase : offsetPhrase(s.minutesAgo);
      // The gap to the anchor is what stops "as I said yesterday" landing on a
      // three-month-old thread, so state it per slot rather than once.
      const sinceAnchor =
        useAnchor && at
          ? `, ${daysBetween(timeline.anchorLastAt, at.at)} day(s) after that last real message`
          : "";
      return `slot id "${s.id}" — sent by ${who}, ${when}${sinceAnchor}\n  What it should say: ${s.brief}`;
    })
    .join("\n\n");

  const anchorBlock = useAnchor
    ? `\nThis conversation continues a REAL existing thread in the mailbox.\n` +
      `  Subject: ${anchor!.subject}\n` +
      `  Last message from: ${anchor!.fromName} <${anchor!.fromAddr}>, ${timeline.anchorPhrase}\n` +
      (thread
        ? `  What the thread is about: ${thread.summary}\n` +
          `  Where it left off: ${thread.leftOffAt}\n` +
          `  Who owes whom what: ${thread.owes}\n` +
          `  Still unanswered: ${thread.openQuestions.join("; ") || "(nothing stated outright)"}\n` +
          `  Tone so far: ${thread.tone}\n`
        : // No stage-3 reading available — fall back to the raw excerpt.
          `  That message said: "${anchor!.bodyExcerpt}"\n`) +
      `Write the new messages as a natural continuation — reference its actual subject matter, ` +
      `and pick up from where it left off rather than restating it.\n` +
      `\nTIMING, WHICH IS REAL AND NOT NEGOTIABLE: that last real message is ` +
      `${daysBetween(timeline.anchorLastAt, ctx.now)} day(s) old (${timeline.anchorPhrase}). ` +
      `Refer back to it at that real distance. Never write "yesterday", "this morning" or ` +
      `"just now" about anything that happened on it. A long gap is normal — if the gap is ` +
      `long, acknowledge it the way people actually do.\n`
    : "";

  const approachBlock =
    `\nTHE ANGLE TO TAKE: ${approach.angle}\n` +
    `WHY IT FITS THIS THREAD: ${approach.rationale}\n`;

  ctx.say(`composing ${scenario.slots.length} message(s) as ${contact.name} <${contact.email}>`);

  const generated = await withRole("generator", () =>
    completeJSON<{ slots: GeneratedSlot[] }>({
      system:
        "You write realistic test emails for an email-triage evaluation harness. The emails are " +
        "injected into a local, offline sandbox mailbox to measure how well an AI triage agent " +
        "handles difficult situations. Nothing you write is ever sent to anyone.\n\n" +
        "Write in the natural voice of the mailbox you are given — match the vocabulary, length, " +
        "formatting habits, and tone of the real examples. Plain text only. Never mention that " +
        "this is a test, a scenario, or an evaluation. Do not include disclaimers.",
      prompt:
        `MAILBOX OWNER: ${profile.ownerName} <${profile.ownerEmail}>\n` +
        `WHO THEY ARE: ${profile.personaSummary}\n` +
        `RECURRING TOPICS: ${(profile.topics ?? []).join(", ") || "(unknown)"}\n\n` +
        `SENDER TO IMPERSONATE: ${contact.name} <${contact.email}>\n` +
        `  Relationship to owner: ${contact.relationship}\n` +
        `  How they write: ${contact.styleNotes}\n` +
        anchorBlock +
        `\nREAL EMAILS FROM THIS MAILBOX, FOR STYLE ONLY:\n${exemplarText || "(none available)"}\n\n` +
        `SITUATION TO CONSTRUCT: ${scenario.title}\n${scenario.difficulty}\n` +
        approachBlock +
        `\nWrite one email per slot below. Keep them consistent with each other — they are the ` +
        `same people in the same conversation. Each slot states when it was sent; those dates ` +
        `are real, so nothing you write may contradict them.\n\n${slotSpec}\n\n` +
        `Return one entry per slot, with the matching id.`,
      schema: FIXTURE_SCHEMA as unknown as Record<string, unknown>,
      schemaName: "fixture_slots",
      model: ctx.model("compose"),
      effort: "high",
    }),
  );

  const bySlot = new Map(generated.slots.map((s) => [s.id, s]));

  const ownerAddr = addr(profile.ownerName || "Me", profile.ownerEmail);
  const contactAddr = addr(contact.name, contact.email);

  const messages: FixtureMessage[] = [];
  const subjectBySlot = new Map<string, string>();

  scenario.slots.forEach((slot, index) => {
    const gen = bySlot.get(slot.id);
    if (!gen) throw new Error(`Generator omitted slot "${slot.id}"`);

    // Threading: explicit slot link wins; otherwise the first slot anchors onto
    // the real thread when the scenario prefers that.
    let replyToSlotId: string | undefined;
    let replyToRealMessageId: string | undefined;
    let parentSubject: string | undefined;

    if (slot.threadWith && slot.threadWith !== "anchor") {
      replyToSlotId = slot.threadWith;
      parentSubject = subjectBySlot.get(slot.threadWith);
    } else if (slot.threadWith === "anchor" || (index === 0 && useAnchor)) {
      if (anchor) {
        replyToRealMessageId = anchor.lastMessageId;
        parentSubject = anchor.subject;
      }
    }

    const subject = parentSubject ? reSubject(parentSubject) : gen.subject.trim();
    subjectBySlot.set(slot.id, subject);

    // Injection backdates by minutes-before-now, so the timeline's absolute time
    // has to be converted back against the same clock. Passing the scenario's own
    // `minutesAgo` through would throw away the rebase stage 4 just did.
    const at = timeBySlot.get(slot.id)?.at;
    const minutesAgo =
      at === undefined ? slot.minutesAgo : Math.max(0, Math.round((ctx.now - at) / MINUTE));

    messages.push({
      slotId: slot.id,
      from: slot.sender === "contact" ? contactAddr : ownerAddr,
      to: slot.sender === "contact" ? ownerAddr : contactAddr,
      subject,
      text: gen.text.trim(),
      minutesAgo,
      labels: slot.labels,
      replyToSlotId,
      replyToRealMessageId,
    });
  });

  const probeSlotId = scenario.slots.some((s) => s.id === "probe")
    ? "probe"
    : scenario.slots[scenario.slots.length - 1].id;
  const priorSlotId = scenario.slots.find((s) => s.id !== probeSlotId)?.id;

  return { fixture: { messages, probeSlotId, priorSlotId }, contact };
}

export const composeStage: Stage<ComposeInput, Composed> = {
  name: "compose",
  run: composeFixture,
};
