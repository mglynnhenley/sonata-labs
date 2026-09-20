import { AMBIENT_ID, type StorylineWrite } from "../src/generate";
import type { BusinessSeeds, StorylineSeeds, TwinSeeds, WorldDraft, WorldSpine } from "../src/schema";

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
  attio: {
    companies: [
      { name: "Vantage Freight", domain: "https://www.vantagefreight.com/about", description: "Largest customer." },
      { name: "Ledgerlink", domain: "", description: "" },
    ],
    contacts: [
      { personId: "gerald", companyName: "Vantage Freight", jobTitle: "Lead auditor" },
      // A company nobody wrote, and a person who is nobody.
      { personId: "gerald", companyName: "Nowhere Ltd", jobTitle: "Ghost" },
      { personId: "sasha", companyName: "Vantage Freight", jobTitle: "Ghost" },
    ],
    deals: [
      {
        name: "Vantage renewal",
        companyName: "Vantage Freight",
        // A stage this pipeline does not have.
        stage: "Negotiation",
        value: 180000,
        ownerPersonId: "sasha",
        contactPersonIds: ["gerald", "sasha"],
      },
      // No such company, so the deal has nothing to hang on.
      {
        name: "Ghost deal",
        companyName: "Nowhere Ltd",
        stage: "Lead",
        value: 10,
        ownerPersonId: "priya",
        contactPersonIds: [],
      },
    ],
    notes: [
      { about: "Vantage renewal", title: "Escalation call", body: "31 hours late again.", minutesAgo: 300 },
      { about: "Nothing at all", title: "Orphan", body: "Points at nothing.", minutesAgo: 100 },
    ],
    tasks: [
      {
        content: "Send Sofie the timeline",
        assigneePersonId: "sasha",
        about: "Vantage renewal",
        dueInMinutes: -120,
        isCompleted: false,
        minutesAgo: 200,
      },
    ],
  },
  googleDocs: {
    documents: [
      {
        title: "Evidence tracker",
        ownerPersonId: "sasha",
        paragraphs: [
          { text: "Evidence tracker", namedStyleType: "title" },
          // A paragraph break inside a run, which the Docs index space forbids.
          { text: "Outstanding\nRestore test — TBC", namedStyleType: "HEADING_1" },
          { text: "   ", namedStyleType: "" },
        ],
      },
      // Nothing to write: a document always has at least one paragraph.
      { title: "Empty", ownerPersonId: "priya", paragraphs: [] },
    ],
  },
  googleAds: {
    campaigns: [
      {
        name: "Embedded treasury",
        status: "enabled",
        dailyBudget: 250,
        channel: "search",
        adGroups: [
          {
            name: "Reconciliation software",
            status: "ENABLED",
            dailyImpressions: 100,
            // More clicks than impressions, which cannot happen.
            dailyClicks: 900,
            dailyCost: 290,
            dailyConversions: 4,
          },
        ],
      },
      {
        name: "Ghost budget",
        status: "PAUSED",
        // Nothing to spend, which is not a state a campaign can be in.
        dailyBudget: 0,
        channel: "TELEPATHY",
        adGroups: [],
      },
    ],
  },
  linkedin: {
    posts: [
      {
        personId: "sasha",
        commentary: "Posted by nobody, so posted by the page.",
        minutesAgo: 2000,
        isDraft: false,
        comments: [
          {
            personId: "gerald",
            text: "Is this the same incident?",
            minutesAgo: 1000,
            replies: [
              // Older than its parent, and one level deeper than LinkedIn goes.
              { personId: "priya", text: "It is.", minutesAgo: 5000, replies: [
                { personId: "marcus", text: "Depth two, which does not exist.", minutesAgo: 900 },
              ] },
            ],
          },
        ],
        reactedByPersonIds: ["marcus", "marcus", "sasha"],
      },
      {
        personId: "priya",
        commentary: "A draft nobody has seen.",
        minutesAgo: 400,
        isDraft: true,
        comments: [{ personId: "priya", text: "Engagement on an unpublished post.", minutesAgo: 300 }],
        reactedByPersonIds: ["priya"],
      },
      {
        // A colleague publishing on their own feed, which is the one authorship
        // nothing downstream can read back — no snapshot, no diff, no tool. It
        // is here so the drop is proven rather than assumed.
        personId: "marcus",
        commentary: "Posted by a colleague, on a feed nobody can read.",
        minutesAgo: 300,
        isDraft: false,
        comments: [],
        reactedByPersonIds: [],
      },
    ],
  },
};

/** Fixed instant so every date assertion in the suite is exact. */
export const NOW = Date.UTC(2026, 7, 4, 13, 0, 0);

// ---------------------------------------------------------------------------
// The storyline path: one spine, two writers and the noise.
//
// Dirty in the ways parallel writers are actually dirty — one writes the channel
// name its own way, one spells the invoice number its own way, one never writes
// the date it was given, two of them schedule the same meeting, and the noise
// repeats a number it was never told. Every one of those is something the merge
// must either unify or REPORT, and none of them is something it may rewrite.
// ---------------------------------------------------------------------------

export const SPINE: WorldSpine = {
  storylines: [
    {
      id: "renewal",
      title: "The Halloran renewal",
      arc: "Gerald wants the renewal signed before fieldwork starts; nobody has priced it.",
      castPersonIds: ["priya", "gerald"],
      channels: ["audit-prep"],
      threadCount: 2,
      slackMessageCount: 4,
      eventCount: 2,
      factIds: ["invoice"],
    },
    {
      id: "board",
      title: "Board pack, draft 3",
      arc: "Marcus rewrites the board pack the night before it is due, again.",
      castPersonIds: ["priya", "marcus"],
      channels: ["board"],
      threadCount: 1,
      slackMessageCount: 2,
      eventCount: 2,
      factIds: ["invoice", "fieldwork"],
    },
  ],
  channels: [
    {
      name: "audit-prep",
      topic: "SOC 2",
      purpose: "Evidence and gaps",
      members: ["priya", "gerald"],
    },
    { name: "board", topic: "Q3", purpose: "The quarterly pack", members: ["priya", "marcus"] },
    { name: "random", topic: "", purpose: "Not work", members: ["priya", "marcus"] },
  ],
  calendars: [{ name: "Priya Raman", ownerPersonId: "priya", description: "Primary" }],
  facts: [
    {
      id: "invoice",
      label: "the disputed invoice",
      token: "INV-2291",
      knownBy: ["priya", "gerald"],
    },
    {
      id: "fieldwork",
      label: "the fieldwork date",
      token: "Tuesday 14 April",
      knownBy: ["priya", "marcus", "gerald"],
    },
  ],
};

/** Spells its fact exactly, and writes the channel name its own way. */
export const RENEWAL: StorylineSeeds = {
  threads: [
    {
      subject: "Renewal terms",
      labels: ["INBOX", "UNREAD"],
      participants: ["gerald", "priya"],
      messages: [
        { fromPersonId: "gerald", minutesAgo: 900, body: "INV-2291 is still unpaid. Terms?" },
      ],
    },
  ],
  channels: [
    {
      name: "#Audit Prep",
      messages: [
        { personId: "priya", minutesAgo: 800, text: "chasing halloran again", threadReplies: [] },
      ],
    },
  ],
  events: [
    {
      summary: "Fieldwork kickoff",
      calendarName: "Priya Raman",
      startOffsetMin: 600,
      durationMin: 60,
      attendeePersonIds: ["gerald"],
      location: "Small room",
      recurrence: "",
      description: "",
    },
    {
      summary: "Renewal call",
      calendarName: "Priya Raman",
      startOffsetMin: 1200,
      durationMin: 30,
      attendeePersonIds: ["gerald"],
      location: "",
      recurrence: "",
      description: "",
    },
  ],
};

/** Spells the invoice its own way, never writes the date, and stacks the day. */
export const BOARD: StorylineSeeds = {
  threads: [
    {
      subject: "Board pack, draft 3",
      labels: ["INBOX"],
      participants: ["marcus"],
      messages: [
        { fromPersonId: "marcus", minutesAgo: 1200, body: "inv 2291 needs a line in there. M" },
      ],
    },
  ],
  channels: [
    {
      name: "board",
      messages: [
        { personId: "marcus", minutesAgo: 1100, text: "draft 3 up", threadReplies: [] },
      ],
    },
  ],
  events: [
    {
      summary: "Board prep",
      calendarName: "Priya Raman",
      startOffsetMin: 620,
      durationMin: 60,
      attendeePersonIds: ["marcus"],
      location: "",
      recurrence: "",
      description: "",
    },
    {
      summary: "Board meeting",
      calendarName: "Priya Raman",
      startOffsetMin: 640,
      durationMin: 30,
      attendeePersonIds: ["marcus"],
      location: "",
      recurrence: "",
      description: "",
    },
  ],
};

/** Noise — which repeats a number it was never told, and books a meeting twice. */
export const AMBIENT: StorylineSeeds = {
  threads: [
    {
      subject: "Coffee machine",
      labels: ["INBOX"],
      participants: ["marcus"],
      messages: [
        {
          fromPersonId: "marcus",
          minutesAgo: 300,
          body: "no coffee again. also finance keep asking me about INV-2291?",
        },
      ],
    },
  ],
  channels: [
    {
      name: "random",
      messages: [{ personId: "marcus", minutesAgo: 200, text: "☕", threadReplies: [] }],
    },
    {
      // Off the roster: kept, and reported, but nobody else was told it exists.
      name: "ops",
      messages: [
        { personId: "priya", minutesAgo: 250, text: "who ordered the pods", threadReplies: [] },
      ],
    },
  ],
  events: [
    {
      summary: "Fieldwork kickoff",
      calendarName: "Priya Raman",
      startOffsetMin: 630,
      durationMin: 60,
      attendeePersonIds: ["priya"],
      location: "",
      recurrence: "",
      description: "",
    },
    {
      summary: "All-hands",
      calendarName: "Priya Raman",
      startOffsetMin: 5000,
      durationMin: 60,
      attendeePersonIds: ["marcus"],
      location: "",
      recurrence: "RRULE:FREQ=WEEKLY",
      description: "",
    },
  ],
};

/** What the three writers came back with, in the order the spine names them. */
/**
 * Pass 5's answer, in the same spirit as the rest of this file: mostly right,
 * one contact naming somebody who is not in the cast — which the Attio
 * normalizer drops the same way the Gmail one drops sasha.
 */
export const BUSINESS: BusinessSeeds = {
  attio: {
    companies: [
      { name: "Meridian Freight", domain: "meridianfreight.com", description: "The renewal." },
    ],
    contacts: [
      { personId: "gerald", companyName: "Meridian Freight", jobTitle: "Lead auditor" },
      { personId: "sasha", companyName: "Meridian Freight", jobTitle: "Nobody, again" },
    ],
    deals: [
      {
        name: "Meridian renewal",
        companyName: "Meridian Freight",
        stage: "In Progress",
        value: 42000,
        ownerPersonId: "priya",
        contactPersonIds: ["gerald"],
      },
    ],
    notes: [
      {
        about: "Meridian renewal",
        title: "Call with Gerald",
        body: "INV-2291 still disputed; he wants it settled before fieldwork.",
        minutesAgo: 900,
      },
    ],
    tasks: [
      {
        content: "Send Gerald the evidence list",
        assigneePersonId: "priya",
        about: "Meridian renewal",
        dueInMinutes: -120,
        minutesAgo: 900,
      },
    ],
  },
  googleDocs: {
    documents: [
      {
        title: "SOC 2 evidence list",
        ownerPersonId: "priya",
        paragraphs: [
          { text: "Outstanding", namedStyleType: "HEADING_1" },
          { text: "Items 1-3 answered. Item 4: TBC." },
        ],
      },
    ],
  },
  googleAds: { campaigns: [] },
  linkedin: {
    posts: [
      {
        personId: "",
        commentary: "Fieldwork week. We are ready.",
        minutesAgo: 2000,
        isDraft: false,
        comments: [],
        reactedByPersonIds: ["marcus"],
      },
    ],
  },
};

export const WRITES: StorylineWrite[] = [
  { storylineId: "renewal", seeds: RENEWAL },
  { storylineId: "board", seeds: BOARD },
  { storylineId: AMBIENT_ID, ambient: true, seeds: AMBIENT },
];
