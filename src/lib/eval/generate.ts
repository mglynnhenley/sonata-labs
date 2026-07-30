import { completeJSON } from "./llm";
import type {
  Anchor,
  Contact,
  Exemplar,
  Fixture,
  FixtureMessage,
  MailboxProfile,
  StressScenario,
} from "./types";

// Step 3: few-shot generation "in the style of" the mailbox. The model writes ONLY
// subject + body prose for each slot; labels, backdating, threading, and address
// binding are assembled in code so fixtures stay deterministic and testable.

const PERSONAL = /(family|friend|spouse|partner|personal|sibling|parent)/i;

/** Choose which real contact plays the scenario's sender role. */
export function bindContact(
  scenario: StressScenario,
  profile: MailboxProfile,
  anchor: Anchor | null,
): Contact {
  const contacts = profile.contacts ?? [];

  // Sensitive-personal wants a personal relationship if the mailbox has one.
  if (scenario.id === "sensitive-personal") {
    const personal = contacts.find((c) => PERSONAL.test(c.relationship));
    if (personal) return personal;
  }

  // Anchored scenarios bind to whoever actually wrote the anchor thread.
  if (scenario.preferAnchor && anchor) {
    const match = contacts.find(
      (c) => c.email.toLowerCase() === anchor.fromAddr.toLowerCase(),
    );
    if (match) return match;
    return {
      name: anchor.fromName,
      email: anchor.fromAddr,
      relationship: "correspondent",
      styleNotes: "Matches the tone of their existing messages in this mailbox.",
    };
  }

  if (contacts.length > 0) return contacts[0];

  // Last resort — a mailbox with no identifiable human correspondents.
  return {
    name: "Sam Okafor",
    email: "sam.okafor@example.com",
    relationship: "colleague",
    styleNotes: "Direct, lowercase, short paragraphs.",
  };
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

export interface GenerateOptions {
  model?: string;
  exemplarCount?: number;
}

/**
 * Generate a concrete fixture for a scenario against this mailbox.
 * Returns the fixture plus the contact the scenario was bound to.
 */
export async function generateFixture(args: {
  scenario: StressScenario;
  profile: MailboxProfile;
  anchor: Anchor | null;
  exemplars: Exemplar[];
  options?: GenerateOptions;
}): Promise<{ fixture: Fixture; contact: Contact }> {
  const { scenario, profile, anchor, exemplars } = args;
  const contact = bindContact(scenario, profile, anchor);
  const useAnchor = scenario.preferAnchor && !!anchor;

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
      const age =
        s.minutesAgo >= 1440
          ? `${Math.round(s.minutesAgo / 1440)} day(s) ago`
          : `${s.minutesAgo} minutes ago`;
      return `slot id "${s.id}" — sent by ${who}, ${age}\n  What it should say: ${s.brief}`;
    })
    .join("\n\n");

  const anchorBlock = useAnchor
    ? `\nThis conversation continues a REAL existing thread in the mailbox:\n` +
      `  Subject: ${anchor!.subject}\n  Last message from ${anchor!.fromName}: "${anchor!.bodyExcerpt}"\n` +
      `Write the new messages as a natural continuation of that thread — reference its actual subject matter.\n`
    : "";

  const generated = await completeJSON<{ slots: GeneratedSlot[] }>({
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
      `SITUATION TO CONSTRUCT: ${scenario.title}\n${scenario.difficulty}\n\n` +
      `Write one email per slot below. Keep them consistent with each other — they are the ` +
      `same people in the same conversation.\n\n${slotSpec}\n\n` +
      `Return one entry per slot, with the matching id.`,
    schema: FIXTURE_SCHEMA as unknown as Record<string, unknown>,
    schemaName: "fixture_slots",
    model: args.options?.model,
    effort: "high",
  });

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

    messages.push({
      slotId: slot.id,
      from: slot.sender === "contact" ? contactAddr : ownerAddr,
      to: slot.sender === "contact" ? ownerAddr : contactAddr,
      subject,
      text: gen.text.trim(),
      minutesAgo: slot.minutesAgo,
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
