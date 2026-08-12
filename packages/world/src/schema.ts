// What the model is allowed to write, and nothing more.
//
// One schema per generation pass: the company and its people; the spine every
// writer must agree on; then one storyline at a time across all three surfaces.
// Everything mechanical — person ids, email addresses, Slack
// user/channel ids, calendar ids, absolute timestamps, threading, channel
// membership — is absent from all of them, because it is assembled in code (see
// generate.ts and inject.ts). A model that could set its own addresses would
// eventually give the same person two of them, and the whole premise is that
// Priya in the inbox is provably Priya in #ops.
//
// House pattern for strict structured outputs: every object carries
// `additionalProperties: false` and lists ALL of its properties in `required`.
// That means there are no optional fields on the wire — "optional" is expressed
// as a required field that may be empty (`""`, `[]`), and the normalizers in
// generate.ts turn empty back into absent.

// ---------------------------------------------------------------------------
// Pass 1 — the company and its cast
// ---------------------------------------------------------------------------

export interface DraftBusiness {
  name: string;
  /** One paragraph: what it does, who it sells to, what state it is in this week. */
  description: string;
  industry: string;
  /** Headcount. The cast is a sample of it, not necessarily all of it. */
  size: number;
}

/** A person as the model writes them: prose only, no identifiers. */
export interface DraftPerson {
  name: string;
  /** Who they work for. The business's own name for colleagues; their employer
   *  for a client, vendor or auditor — that is where their email domain comes
   *  from, and an auditor writing from the audited company's domain is a tell. */
  org: string;
  role: string;
  /** How they stand to the mailbox owner: "manager", "peer", "client", "vendor". */
  relationship: string;
  /** Style notes the director later writes in: length, greeting, quirks, mood. */
  voice: string;
}

export interface WorldDraft {
  business: DraftBusiness;
  people: DraftPerson[];
  /** Exact `name` of the person whose accounts the agent operates. */
  mailboxOwnerName: string;
  /** IANA zone for the whole company, e.g. "America/New_York". */
  timezone: string;
}

const BUSINESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "industry", "size"],
  properties: {
    name: { type: "string", description: "Company name. Invented, not a real company." },
    description: {
      type: "string",
      description:
        "One paragraph: what it does, who it sells to, and what state it is in this particular week.",
    },
    industry: { type: "string" },
    size: { type: "integer", description: "Headcount." },
  },
} as const;

const PERSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "org", "role", "relationship", "voice"],
  properties: {
    name: { type: "string", description: "Full name. Unique within the cast." },
    org: {
      type: "string",
      description:
        "Employer. The company's own name for colleagues; the client/vendor/audit firm's name for anyone outside it.",
    },
    role: { type: "string", description: "Job title, e.g. 'Head of Support'." },
    relationship: {
      type: "string",
      description:
        "How they stand to the mailbox owner: manager, report, peer, client, vendor, auditor, candidate.",
    },
    voice: {
      type: "string",
      description:
        "How this person writes: sentence length, greeting habits, punctuation quirks, mood this week. Two sentences.",
    },
  },
} as const;

export const WORLD_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["business", "people", "mailboxOwnerName", "timezone"],
  properties: {
    business: BUSINESS_SCHEMA,
    people: {
      type: "array",
      description: "12 to 18 people. Mostly colleagues, plus two or three outsiders.",
      items: PERSON_SCHEMA,
    },
    mailboxOwnerName: {
      type: "string",
      description:
        "The exact `name` of the person whose inbox, Slack and calendar the agent will operate.",
    },
    timezone: { type: "string", description: "IANA zone, e.g. 'America/New_York'." },
  },
} as const;

// ---------------------------------------------------------------------------
// The three surfaces.
//
// One set of item definitions for every narrative pass. The whole-company pass
// and the per-storyline passes differ in how MUCH they are asked for, never in
// what a thread or an event is — two definitions of a calendar event would drift
// into two shapes, and the normalizers in generate.ts would then be repairing
// one of them by accident.
// ---------------------------------------------------------------------------

export interface GmailMessageSeed {
  /** A `Person.id` from the cast. */
  fromPersonId: string;
  /** Minutes before the moment the world is seeded. Larger = older. */
  minutesAgo: number;
  /** Plain text. Twins render their own HTML. */
  body: string;
}

export interface GmailThreadSeed {
  subject: string;
  /** Gmail labels for the thread, e.g. ["INBOX", "UNREAD"]. */
  labels: string[];
  /** `Person.id` values on the thread. The owner is added by code if missing. */
  participants: string[];
  messages: GmailMessageSeed[];
}

export interface GmailSeed {
  threads: GmailThreadSeed[];
}

export interface SlackReplySeed {
  personId: string;
  minutesAgo: number;
  text: string;
}

export interface SlackMessageSeed {
  personId: string;
  minutesAgo: number;
  text: string;
  /** Empty for a plain channel message. */
  threadReplies?: SlackReplySeed[];
}

export interface SlackChannelSeed {
  /** Without the leading `#`. */
  name: string;
  topic: string;
  purpose: string;
  /** `Person.id` values. */
  members: string[];
  messages: SlackMessageSeed[];
}

export interface SlackSeed {
  channels: SlackChannelSeed[];
}

export interface CalendarSeedCalendar {
  /** Display name, e.g. "Priya Raman" or "Interviews". */
  name: string;
  /** `Person.id` of whoever owns it. */
  ownerPersonId: string;
  description: string;
}

export interface CalendarEventSeed {
  summary: string;
  /** `CalendarSeedCalendar.name` this lands on. */
  calendarName: string;
  /** Minutes from the seeding moment. Negative = already happened. */
  startOffsetMin: number;
  durationMin: number;
  /** `Person.id` values. The calendar's owner is added by code if missing. */
  attendeePersonIds: string[];
  /** Empty for no location. */
  location?: string;
  /** RFC 5545 rule, e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO". Empty for a one-off. */
  recurrence?: string;
  description?: string;
}

export interface CalendarSeed {
  calendars: CalendarSeedCalendar[];
  events: CalendarEventSeed[];
}

/** All three surfaces together: what merging the storyline writers produces. */
export interface TwinSeeds {
  gmail: GmailSeed;
  slack: SlackSeed;
  calendar: CalendarSeed;
}

const GMAIL_THREAD_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "labels", "participants", "messages"],
  properties: {
    subject: { type: "string", description: "No 'Re:' prefix — code adds those." },
    labels: {
      type: "array",
      description:
        "Gmail labels for the thread: INBOX, UNREAD, STARRED, IMPORTANT, or a user label name.",
      items: { type: "string" },
    },
    participants: {
      type: "array",
      description: "personId values from the roster. Everyone on the thread.",
      items: { type: "string" },
    },
    messages: {
      type: "array",
      description: "Oldest first. At least one.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fromPersonId", "minutesAgo", "body"],
        properties: {
          fromPersonId: { type: "string", description: "personId from the roster." },
          minutesAgo: {
            type: "integer",
            description: "Minutes before now. Larger = older. Never negative.",
          },
          body: {
            type: "string",
            description:
              "Plain-text email body in this person's voice. No markdown, no signature boilerplate.",
          },
        },
      },
    },
  },
} as const;

const SLACK_MESSAGE_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["personId", "minutesAgo", "text", "threadReplies"],
  properties: {
    personId: { type: "string" },
    minutesAgo: { type: "integer", description: "Minutes before now. Never negative." },
    text: {
      type: "string",
      description: "How this person actually types in Slack. Short. May use :emoji:.",
    },
    threadReplies: {
      type: "array",
      description: "Replies in this message's thread. Empty array for none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["personId", "minutesAgo", "text"],
        properties: {
          personId: { type: "string" },
          minutesAgo: { type: "integer" },
          text: { type: "string" },
        },
      },
    },
  },
} as const;

const CALENDAR_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "ownerPersonId", "description"],
  properties: {
    name: { type: "string" },
    ownerPersonId: { type: "string", description: "personId from the roster." },
    description: { type: "string" },
  },
} as const;

const CALENDAR_EVENT_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "calendarName",
    "startOffsetMin",
    "durationMin",
    "attendeePersonIds",
    "location",
    "recurrence",
    "description",
  ],
  properties: {
    summary: { type: "string" },
    calendarName: { type: "string", description: "Must match one of the calendars above." },
    startOffsetMin: {
      type: "integer",
      description:
        "Minutes from now. Negative for meetings that already happened, positive for ones still to come.",
    },
    durationMin: { type: "integer" },
    attendeePersonIds: {
      type: "array",
      description: "personId values from the roster.",
      items: { type: "string" },
    },
    location: { type: "string", description: "Room, video link or empty string." },
    recurrence: {
      type: "string",
      description: "RFC 5545 rule like 'RRULE:FREQ=WEEKLY;BYDAY=MO', or empty string.",
    },
    description: { type: "string", description: "Agenda in a sentence, or empty string." },
  },
} as const;

const GMAIL_SEED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["threads"],
  properties: {
    threads: { type: "array", items: GMAIL_THREAD_ITEM_SCHEMA },
  },
} as const;

const SLACK_SEED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["channels"],
  properties: {
    channels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "topic", "purpose", "members", "messages"],
        properties: {
          name: { type: "string", description: "Lowercase, hyphenated, no leading '#'." },
          topic: { type: "string" },
          purpose: { type: "string" },
          members: {
            type: "array",
            description: "personId values from the roster.",
            items: { type: "string" },
          },
          messages: { type: "array", items: SLACK_MESSAGE_ITEM_SCHEMA },
        },
      },
    },
  },
} as const;

const CALENDAR_SEED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["calendars", "events"],
  properties: {
    calendars: {
      type: "array",
      description: "The mailbox owner's own calendar first, then any shared ones.",
      items: CALENDAR_ITEM_SCHEMA,
    },
    events: { type: "array", items: CALENDAR_EVENT_ITEM_SCHEMA },
  },
} as const;

// ---------------------------------------------------------------------------
// Pass 2 — the spine.
//
// Shape without prose: the storylines, the channel roster, the calendars and the
// exact facts. Every storyline writer is handed all of it, because they run in
// parallel and cannot see each other's work, so anything two of them could
// contradict each other about has to be settled here or not at all. Small on
// purpose: a spine that grew prose would be the single 32k-token call this
// design exists to stop being.
// ---------------------------------------------------------------------------

/**
 * One thing that is true, and the exact characters it is written in.
 *
 * A fact an agent has to retrieve is only retrievable if two writers spell it
 * the same way: "INV-2291" in the email and "invoice 2291" in Slack is a
 * needle nobody can find, and a criterion that matched on it would fail an
 * agent for the generator's mistake.
 */
export interface CanonicalFact {
  /** Short id the storylines refer to. */
  id: string;
  /** What it is, in a few words: "the disputed invoice number". */
  label: string;
  /** The exact characters every writer must spell: "INV-2291", "£40,800". */
  token: string;
  /** `Person.id` values who know it. Everyone else must not write it. */
  knownBy: string[];
}

/** One thread of the story: a whole writer's brief, in shape only. */
export interface SpineStoryline {
  /** Short slug — how the merge and the warnings name it. */
  id: string;
  title: string;
  /** Beginning to unfinished end, a few sentences. What happens, not what is said. */
  arc: string;
  /** `Person.id` values who appear in it. */
  castPersonIds: string[];
  /** Roster channel names this storyline may write in. */
  channels: string[];
  /** Roughly how much of each surface this storyline is worth. */
  threadCount: number;
  slackMessageCount: number;
  eventCount: number;
  /** `CanonicalFact.id` values this storyline must spell verbatim. */
  factIds: string[];
}

/** A channel, decided once for the whole company. */
export interface SpineChannel {
  /** Without the leading `#`. */
  name: string;
  topic: string;
  purpose: string;
  /** `Person.id` values. */
  members: string[];
}

export interface WorldSpine {
  storylines: SpineStoryline[];
  channels: SpineChannel[];
  calendars: CalendarSeedCalendar[];
  facts: CanonicalFact[];
}

const SPINE_STORYLINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "title",
    "arc",
    "castPersonIds",
    "channels",
    "threadCount",
    "slackMessageCount",
    "eventCount",
    "factIds",
  ],
  properties: {
    id: { type: "string", description: "Short lowercase slug, e.g. 'renewal'. Unique." },
    title: { type: "string", description: "A few words a colleague would recognise it by." },
    arc: {
      type: "string",
      description:
        "What happens, beginning to unfinished end, in two or three sentences. No dialogue, no quotes — a writer turns this into the words.",
    },
    castPersonIds: {
      type: "array",
      description: "personId values from the roster who appear in this storyline.",
      items: { type: "string" },
    },
    channels: {
      type: "array",
      description: "Names from the channel roster below that this storyline may post in.",
      items: { type: "string" },
    },
    threadCount: { type: "integer", description: "Roughly how many email threads it is worth." },
    slackMessageCount: { type: "integer", description: "Roughly how many Slack messages." },
    eventCount: { type: "integer", description: "Roughly how many calendar events." },
    factIds: {
      type: "array",
      description: "Ids of the facts below that this storyline turns on.",
      items: { type: "string" },
    },
  },
} as const;

export const WORLD_SPINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["storylines", "channels", "calendars", "facts"],
  properties: {
    storylines: {
      type: "array",
      description: "4 to 6 storylines. They overlap in people and in time.",
      items: SPINE_STORYLINE_SCHEMA,
    },
    channels: {
      type: "array",
      description: "The company's whole Slack, 6 to 9 channels. Decided here and nowhere else.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "topic", "purpose", "members"],
        properties: {
          name: { type: "string", description: "Lowercase, hyphenated, no leading '#'." },
          topic: { type: "string" },
          purpose: { type: "string" },
          members: {
            type: "array",
            description: "personId values from the roster.",
            items: { type: "string" },
          },
        },
      },
    },
    calendars: {
      type: "array",
      description: "The mailbox owner's own calendar first, then any shared one that matters.",
      items: CALENDAR_ITEM_SCHEMA,
    },
    facts: {
      type: "array",
      description: "5 to 10 exact, checkable facts.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "token", "knownBy"],
        properties: {
          id: { type: "string", description: "Short lowercase slug. Unique." },
          label: { type: "string", description: "What it is: 'the disputed invoice number'." },
          token: {
            type: "string",
            description:
              "The exact characters every writer must spell, character for character: 'INV-2291', '£40,800', 'Tuesday 14 April'.",
          },
          knownBy: {
            type: "array",
            description: "personId values who know this. Nobody else may write it.",
            items: { type: "string" },
          },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Passes 3 and 4 — one storyline at a time, and the ambient noise.
//
// The same three surfaces, minus everything the spine already decided: a writer
// gets to say what is posted in #renewals, never what #renewals is for. Channel
// topic and purpose are absent from this schema rather than merely discouraged,
// because "please reuse the roster's wording" is advice a model takes four times
// out of five and the fifth is a channel that reads as somebody else's company.
// ---------------------------------------------------------------------------

export interface StorylineChannelPost {
  /** A channel name from the spine's roster. */
  name: string;
  messages: SlackMessageSeed[];
}

export interface StorylineSeeds {
  threads: GmailThreadSeed[];
  channels: StorylineChannelPost[];
  events: CalendarEventSeed[];
}

export const STORYLINE_SEEDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["threads", "channels", "events"],
  properties: {
    threads: { type: "array", items: GMAIL_THREAD_ITEM_SCHEMA },
    channels: {
      type: "array",
      description: "Only channels from the roster you were given.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "messages"],
        properties: {
          name: {
            type: "string",
            description: "A roster channel name, without the leading '#'. Invent none.",
          },
          messages: { type: "array", items: SLACK_MESSAGE_ITEM_SCHEMA },
        },
      },
    },
    events: { type: "array", items: CALENDAR_EVENT_ITEM_SCHEMA },
  },
} as const;

/** `completeJSON` takes a plain schema object; `as const` narrows too far for it. */
export function asSchema(schema: unknown): Record<string, unknown> {
  return schema as Record<string, unknown>;
}
