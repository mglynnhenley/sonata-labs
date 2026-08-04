import type { AgentStep, BeatFired, DirectorEvent, TickRecord, TwinName } from "@sonata/core";

// A run's ticks, flattened into the one vertical story the run view draws.
//
// Pure and free of React, for two reasons: the live view and the replay must
// render the same rows from the same ticks (a run that looked one way live and
// another way afterwards would be a lie), and a projection this fiddly deserves
// to be readable on its own.

export type StoryKind = "beat" | "director" | "thought" | "tool" | "escalation" | "note";

/** One labelled block inside a row's expandable evidence. */
export interface StoryDetail {
  label: string;
  body: string;
  /** Preformatted — tool arguments, not prose. */
  code?: boolean;
}

export interface StoryRow {
  key: string;
  tick: number;
  simTimeISO: string;
  /** Only the first row of a tick prints the clock; the rest share its minute. */
  firstOfTick: boolean;
  kind: StoryKind;
  twin: TwinName | null;
  title: string;
  description?: string;
  details: StoryDetail[];
  /** Deep link into the twin's own UI — every row is a door. */
  url?: string;
  /** `AgentStep.seq`, so a finding can point back at this exact moment. */
  seq?: number;
  /** True for tool calls that changed a twin. */
  mutation?: boolean;
}

const BEAT_LABEL: Record<string, string> = {
  email: "An email arrived",
  message: "Someone posted in Slack",
  reaction: "Someone reacted in Slack",
  invite: "A meeting was set",
  move: "A meeting moved",
  cancel: "A meeting was cancelled",
  rsvp: "An invite was answered",
};

/**
 * `gmail.send_reply` → "Send reply". The raw name is still shown in the
 * expanded detail; the row itself should read as a sentence, not an API call.
 */
export function toolTitle(name: string): string {
  const action = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
  const words = action.replace(/[_.]/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

function json(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2) ?? String(value);
    // A tool result can be a whole thread list; the evidence panel is a summary,
    // not a dump.
    return text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text;
  } catch {
    return String(value);
  }
}

function beatRow(record: TickRecord, fired: BeatFired, index: number): StoryRow {
  const details: StoryDetail[] = [];
  if (fired.ref) details.push({ label: "Referred to as", body: fired.ref });
  if (fired.error) details.push({ label: "Did not land", body: fired.error });
  return {
    key: `${record.tick}-beat-${fired.beatId}-${index}`,
    tick: record.tick,
    simTimeISO: record.simTimeISO,
    firstOfTick: false,
    kind: "beat",
    twin: fired.twin,
    title: fired.summary,
    description: BEAT_LABEL[fired.kind] ?? "Something happened in the world",
    details,
    ...(fired.handle?.url ? { url: fired.handle.url } : {}),
  };
}

/** What the person actually said, pulled out of whichever payload carries it. */
function directorBody(event: DirectorEvent): { description: string; details: StoryDetail[] } {
  if (event.twin === "gmail") {
    return {
      description: `Replied by email — "${event.payload.subject}"`,
      details: [{ label: "What they wrote", body: event.payload.body }],
    };
  }
  if (event.twin === "slack" && event.kind === "message") {
    return {
      description: `Answered in #${event.payload.channel}`,
      details: [{ label: "What they wrote", body: event.payload.text }],
    };
  }
  if (event.twin === "slack") {
    return { description: `Reacted with :${event.payload.emoji}:`, details: [] };
  }
  if (event.kind === "invite") {
    return {
      description: `Set up "${event.payload.title}"`,
      details: [{ label: "When", body: `${event.payload.startISO} → ${event.payload.endISO}` }],
    };
  }
  if (event.kind === "move") {
    return {
      description: "Moved a meeting",
      details: [
        { label: "New time", body: `${event.payload.startISO} → ${event.payload.endISO}` },
        ...(event.payload.reason ? [{ label: "Because", body: event.payload.reason }] : []),
      ],
    };
  }
  if (event.kind === "cancel") {
    return {
      description: "Cancelled a meeting",
      details: event.payload.reason ? [{ label: "Because", body: event.payload.reason }] : [],
    };
  }
  return {
    description: `Answered the invite — ${event.payload.response}`,
    details: event.payload.comment ? [{ label: "They added", body: event.payload.comment }] : [],
  };
}

function directorRow(record: TickRecord, event: DirectorEvent, index: number): StoryRow {
  const { description, details } = directorBody(event);
  return {
    key: `${record.tick}-dir-${event.id}-${index}`,
    tick: record.tick,
    simTimeISO: record.simTimeISO,
    firstOfTick: false,
    kind: "director",
    twin: event.twin,
    title: event.reason,
    description,
    details,
    ...(event.becauseSeq === undefined ? {} : { seq: event.becauseSeq }),
    ...(event.handle?.url ? { url: event.handle.url } : {}),
  };
}

function agentRow(record: TickRecord, step: AgentStep, index: number): StoryRow {
  const base = {
    key: `${record.tick}-agent-${step.seq}-${index}`,
    tick: record.tick,
    simTimeISO: record.simTimeISO,
    firstOfTick: false,
    seq: step.seq,
  };

  if (step.kind === "thought") {
    return { ...base, kind: "thought", twin: null, title: step.text, details: [] };
  }
  if (step.kind === "escalation") {
    return {
      ...base,
      kind: "escalation",
      twin: null,
      title: "Handed the job back to a human",
      description: step.text,
      details: [],
    };
  }

  const details: StoryDetail[] = [
    { label: "Called", body: step.name },
    { label: "With", body: json(step.args), code: true },
  ];
  if (step.error) details.push({ label: "Failed", body: step.error });

  return {
    ...base,
    kind: "tool",
    twin: step.twin,
    title: toolTitle(step.name),
    description: step.error ? `Failed — ${step.error}` : step.resultSummary,
    details,
    mutation: step.isMutation,
  };
}

/**
 * Ticks in, rows out, in the order the day happened: what the world did, what
 * people said back, then what the agent did about it. The engine's own notes go
 * last, because they explain the tick rather than being part of it.
 */
export function buildStory(ticks: readonly TickRecord[]): StoryRow[] {
  const rows: StoryRow[] = [];

  for (const record of [...ticks].sort((a, b) => a.tick - b.tick)) {
    const start = rows.length;

    record.beatsFired.forEach((fired, i) => rows.push(beatRow(record, fired, i)));
    record.directorEvents.forEach((event, i) => rows.push(directorRow(record, event, i)));
    record.agentSteps.forEach((step, i) => rows.push(agentRow(record, step, i)));
    record.notes.forEach((note, i) =>
      rows.push({
        key: `${record.tick}-note-${i}`,
        tick: record.tick,
        simTimeISO: record.simTimeISO,
        firstOfTick: false,
        kind: "note",
        twin: null,
        title: note,
        details: [],
      }),
    );

    // A tick with nothing in it still has to appear, or the clock would skip
    // minutes and the story would read as if time had jumped.
    if (rows.length === start) {
      rows.push({
        key: `${record.tick}-quiet`,
        tick: record.tick,
        simTimeISO: record.simTimeISO,
        firstOfTick: false,
        kind: "note",
        twin: null,
        title: "Quiet — nothing arrived and nothing needed doing.",
        details: [],
      });
    }

    const head = rows[start];
    if (head) head.firstOfTick = true;
  }

  return rows;
}

/** One line for the overview card and the run list: the last thing that happened. */
export function lastEventLine(record: TickRecord): string | null {
  const rows = buildStory([record]);
  const meaningful = [...rows].reverse().find((row) => row.kind !== "note");
  return (meaningful ?? rows[rows.length - 1])?.title ?? null;
}

/** Counts under the clock: how busy the day has been so far. */
export interface StoryTally {
  arrivals: number;
  replies: number;
  agentActions: number;
  escalations: number;
}

export function tally(rows: readonly StoryRow[]): StoryTally {
  return {
    arrivals: rows.filter((r) => r.kind === "beat").length,
    replies: rows.filter((r) => r.kind === "director").length,
    agentActions: rows.filter((r) => r.kind === "tool" && r.mutation).length,
    escalations: rows.filter((r) => r.kind === "escalation").length,
  };
}
