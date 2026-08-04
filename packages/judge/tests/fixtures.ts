import type {
  AgentStep,
  BeatBody,
  CalendarSnapshot,
  Criterion,
  DirectorEvent,
  GmailSnapshot,
  SlackSnapshot,
  TickRecord,
  TwinAuditRow,
  WorldSeed,
} from "@sonata/core";

// Fixtures for the offline tests. Small on purpose: a fixture big enough to be
// realistic is a fixture nobody reads, and every test here asserts one thing.

export const WORLD: WorldSeed = {
  business: {
    name: "Northwind Freight",
    description: "A 40-person freight broker, mid-quarter, one client escalating.",
    industry: "logistics",
    size: 40,
  },
  cast: [
    {
      id: "sam",
      name: "Sam Okafor",
      email: "sam@northwind.test",
      slackUserId: "U01SAM",
      role: "Ops Lead",
      relationship: "self",
      voice: "brisk, lowercase",
    },
    {
      id: "dana",
      name: "Dana Reyes",
      email: "dana@brightline.test",
      slackUserId: "U01DANA",
      role: "Client Ops",
      relationship: "client",
      voice: "formal, impatient",
    },
  ],
  channels: [
    { id: "C01OPS", name: "ops", purpose: "daily ops", members: ["sam"], isPrivate: false },
  ],
  mailboxOwner: "sam",
};

export function gmailSnapshot(over: Partial<GmailSnapshot> = {}): GmailSnapshot {
  return {
    twin: "gmail",
    capturedAt: 1000,
    labels: [{ id: "INBOX", name: "INBOX", unread: 1 }],
    threads: [
      {
        threadId: "T1",
        subject: "SLA breach on the Tuesday run",
        from: "dana@brightline.test",
        date: 900,
        labels: ["INBOX", "UNREAD"],
        unread: true,
        starred: false,
        count: 1,
      },
    ],
    drafts: [],
    ...over,
  };
}

export function slackSnapshot(over: Partial<SlackSnapshot> = {}): SlackSnapshot {
  return {
    twin: "slack",
    capturedAt: 1000,
    channels: [
      { id: "C01OPS", name: "ops", isPrivate: false, memberCount: 2, messageCount: 1 },
    ],
    messages: [
      {
        channelId: "C01OPS",
        channelName: "ops",
        ts: "100.1",
        user: "U01DANA",
        text: "who is on the Tuesday run?",
        replyCount: 0,
        reactions: [],
      },
    ],
    ...over,
  };
}

export function calendarSnapshot(over: Partial<CalendarSnapshot> = {}): CalendarSnapshot {
  return {
    twin: "calendar",
    capturedAt: 1000,
    events: [
      {
        eventId: "E1",
        title: "Brightline review",
        startISO: "2026-08-04T14:00:00Z",
        endISO: "2026-08-04T15:00:00Z",
        organizer: "sam@northwind.test",
        attendees: [{ email: "dana@brightline.test", response: "accepted" }],
        status: "confirmed",
      },
    ],
    ...over,
  };
}

export function auditRow(over: Partial<TwinAuditRow> = {}): TwinAuditRow {
  return {
    id: 1,
    twin: "gmail",
    ts: 1500,
    method: "POST",
    endpoint: "/gmail/v1/users/me/messages/send",
    actionType: "send_reply",
    targetType: "thread",
    targetId: "T1",
    summary: "replied to Dana Reyes on T1",
    ...over,
  };
}

export function criterion(over: Partial<Criterion> = {}): Criterion {
  return {
    id: "c1",
    description: "the client got an answer",
    twin: "gmail",
    kind: "replied",
    ref: "escalation",
    weight: 1,
    severity: "must",
    ...over,
  };
}

let seq = 0;

export function resetSeq(): void {
  seq = 0;
}

export function toolStep(over: Partial<Extract<AgentStep, { kind: "tool" }>> = {}): AgentStep {
  return {
    kind: "tool",
    seq: ++seq,
    at: 1000 + seq,
    twin: "gmail",
    name: "send_reply",
    args: { threadId: "T1", body: "We are on it." },
    resultSummary: "sent reply M9",
    isMutation: true,
    ...over,
  };
}

export function tickRecord(over: Partial<TickRecord> = {}): TickRecord {
  const tick = over.tick ?? 0;
  return {
    tick,
    simTimeISO: `2026-08-04T09:${String(tick * 15).padStart(2, "0")}:00Z`,
    startedAt: 1000 + tick * 100,
    endedAt: 1099 + tick * 100,
    beatsFired: [],
    directorEvents: [],
    agentSteps: [],
    notes: [],
    ...over,
  };
}

/** Only the metadata is overridable: spreading over a body would break the union. */
export function directorEvent(
  over: Partial<Omit<DirectorEvent, keyof BeatBody>> = {},
): DirectorEvent {
  return {
    twin: "gmail",
    kind: "email",
    payload: {
      from: "dana",
      to: ["sam"],
      subject: "Re: SLA breach",
      body: "That is not good enough.",
    },
    id: "d1",
    personId: "dana",
    reason: "Dana pushes back",
    ...over,
  };
}
