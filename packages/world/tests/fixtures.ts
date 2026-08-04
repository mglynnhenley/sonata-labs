import type { TwinSeeds, WorldDraft } from "../src/schema";

// A deliberately dirty pair of model outputs: it names a person who is not in the
// cast ("sasha"), writes messages out of order, puts a thread reply BEFORE its
// parent, shouts a label in lower case and writes a channel name Slack would
// reject. Every one of those is a thing a real model has done, and the point of
// the fixture is that assembly cleans all of it up without a second model call.

export const DRAFT: WorldDraft = {
  business: {
    name: "Northwind Ledger",
    description: "Embedded treasury for freight companies, one week before SOC 2 fieldwork.",
    industry: "Financial technology",
    size: 12,
  },
  people: [
    {
      name: "Priya Raman",
      org: "Northwind Ledger",
      role: "Chief of Staff",
      relationship: "self",
      voice: "Tight paragraphs, always names an owner and a date.",
    },
    {
      name: "Marcus Bell",
      org: "Northwind Ledger",
      role: "Chief Executive",
      relationship: "manager",
      voice: "Long, warm, sent near midnight.",
    },
    {
      name: "Gerald Pike",
      org: "Halloran & Pike",
      role: "Lead auditor",
      relationship: "auditor",
      voice: "Polite, clipped, immovable on dates.",
    },
  ],
  mailboxOwnerName: "Priya Raman",
  timezone: "America/New_York",
};

export const SEEDS: TwinSeeds = {
  gmail: {
    threads: [
      {
        subject: "Re: SOC 2 evidence request",
        labels: ["inbox", "unread", "Audit"],
        participants: ["gerald"],
        messages: [
          // Newest first, which is the wrong way round for a thread.
          { fromPersonId: "gerald", minutesAgo: 200, body: "Following up on items 1 to 3." },
          { fromPersonId: "gerald", minutesAgo: 2800, body: "Four items remain outstanding." },
          { fromPersonId: "priya", minutesAgo: 1600, body: "Aisha is on it, answer today." },
          { fromPersonId: "sasha", minutesAgo: 100, body: "Who is Sasha? Nobody." },
        ],
      },
      {
        subject: "Board pack, draft 3",
        labels: [],
        participants: ["marcus", "priya"],
        messages: [{ fromPersonId: "marcus", minutesAgo: 1200, body: "Close, I think. M" }],
      },
      {
        subject: "Entirely ghost thread",
        labels: ["INBOX"],
        participants: ["sasha"],
        messages: [{ fromPersonId: "sasha", minutesAgo: 30, body: "Dropped on the floor." }],
      },
    ],
  },
  slack: {
    channels: [
      {
        name: "#Audit Prep",
        topic: "SOC 2",
        purpose: "Evidence and gaps",
        members: ["gerald"],
        messages: [
          {
            personId: "marcus",
            minutesAgo: 600,
            text: "auditors on site monday",
            threadReplies: [
              // Older than its parent, which cannot happen.
              { personId: "gerald", minutesAgo: 900, text: "kindly confirm the room" },
              { personId: "sasha", minutesAgo: 400, text: "ghost reply" },
            ],
          },
          { personId: "gerald", minutesAgo: 1800, text: "walkthrough notes attached" },
        ],
      },
    ],
  },
  calendar: {
    calendars: [{ name: "Priya Raman", ownerPersonId: "priya", description: "Primary" }],
    events: [
      {
        summary: "Fieldwork day 1",
        calendarName: "Priya Raman",
        startOffsetMin: 5760,
        durationMin: 480,
        attendeePersonIds: ["gerald", "sasha"],
        location: "Small room",
        recurrence: "freq=weekly",
        description: "",
      },
      {
        summary: "Standup",
        calendarName: "Nowhere",
        startOffsetMin: -60,
        durationMin: 0,
        attendeePersonIds: ["marcus"],
        location: "",
        recurrence: "RRULE:FREQ=DAILY",
        description: "",
      },
    ],
  },
};

/** Fixed instant so every date assertion in the suite is exact. */
export const NOW = Date.UTC(2026, 7, 4, 13, 0, 0);
