// What the model is allowed to write, and nothing more.
//
// Two schemas, one per generation pass: the company and its people, then the
// story as it appears on the three surfaces. Everything mechanical — person ids,
// email addresses, Slack user/channel ids, calendar ids, absolute timestamps,
// threading, channel membership — is absent from both, because it is assembled
// in code (see generate.ts and inject.ts). A model that could set its own
// addresses would eventually give the same person two of them, and the whole
// premise is that Priya in the inbox is provably Priya in #ops.
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
      description: "6 to 10 people. Mostly colleagues, plus at least one outsider.",
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
// Pass 2 — the same story on three surfaces
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

/** The one narrative pass: all three surfaces written together so they agree. */
export interface TwinSeeds {
  gmail: GmailSeed;
  slack: SlackSeed;
  calendar: CalendarSeed;
}

const GMAIL_SEED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["threads"],
  properties: {
    threads: {
      type: "array",
      items: {
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
      },
    },
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
          messages: {
            type: "array",
            items: {
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
            },
          },
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
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "ownerPersonId", "description"],
        properties: {
          name: { type: "string" },
          ownerPersonId: { type: "string", description: "personId from the roster." },
          description: { type: "string" },
        },
      },
    },
    events: {
      type: "array",
      items: {
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
      },
    },
  },
} as const;

export const TWIN_SEEDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gmail", "slack", "calendar"],
  properties: {
    gmail: GMAIL_SEED_SCHEMA,
    slack: SLACK_SEED_SCHEMA,
    calendar: CALENDAR_SEED_SCHEMA,
  },
} as const;

/** `completeJSON` takes a plain schema object; `as const` narrows too far for it. */
export function asSchema(schema: unknown): Record<string, unknown> {
  return schema as Record<string, unknown>;
}
