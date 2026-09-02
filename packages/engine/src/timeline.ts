import type {
  AttioBeatBody,
  BeatBody,
  BeatFired,
  CalendarBeatBody,
  DirectorEvent,
  GoogleDocsBeatBody,
  TickRecord,
  TimelineEntry,
  TwinName,
} from "@sonata/core";

// The run's story, flattened. Two readers, one source:
//
//   - the judge and the run view get `runTimeline` — every row, in order, with
//     its source, so a finding can point at the moment it happened;
//   - the agent gets `tickDigest` — deliberately much less.

/** Rows for one tick, in the order the tick actually played them. */
export function tickEntries(record: TickRecord): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const at = { tick: record.tick, simTimeISO: record.simTimeISO };

  for (const beat of record.beatsFired) {
    out.push({
      ...at,
      source: "world",
      twin: beat.twin,
      text: beat.error ? `${beat.summary} — did not land: ${beat.error}` : beat.summary,
    });
  }
  for (const event of record.directorEvents) {
    out.push({
      ...at,
      source: "director",
      twin: event.twin,
      text: event.error ? `${describeEvent(event)} — did not land: ${event.error}` : describeEvent(event),
    });
  }
  for (const step of record.agentSteps) {
    out.push({
      ...at,
      source: "agent",
      twin: step.kind === "tool" ? step.twin : null,
      text: describeStep(step),
      seq: step.seq,
    });
  }
  return out;
}

export function runTimeline(ticks: TickRecord[]): TimelineEntry[] {
  return ticks.flatMap(tickEntries);
}

function describeStep(step: TickRecord["agentSteps"][number]): string {
  if (step.kind === "thought") return step.text;
  if (step.kind === "escalation") return `escalated to the owner: ${step.text}`;
  return step.error
    ? `${step.name} failed: ${step.error}`
    : `${step.name} → ${step.resultSummary}`;
}

/** A director event as the timeline reads it: who did what, and why. */
export function describeEvent(event: DirectorEvent): string {
  const what = bodyLabel(event);
  return event.reason ? `${what} — ${event.reason}` : what;
}

function bodyLabel(body: BeatBody & { personId?: string }): string {
  // A director event names its actor; a beat body reaching here without one is
  // an actor we genuinely do not know, so the line says so rather than guessing.
  const who = body.personId ?? "someone";
  switch (body.twin) {
    case "gmail":
      return `${who} emailed: "${body.payload.subject}"`;
    case "slack":
      return body.kind === "message"
        ? `${who} posted in #${body.payload.channel.replace(/^#/, "")}`
        : `${who} reacted :${body.payload.emoji}:`;
    case "calendar":
      return calendarLabel(body, who);
    case "attio":
      return attioLabel(body, who);
    case "google-docs":
      return docsLabel(body, who);
  }
}

function calendarLabel(body: CalendarBeatBody, who: string): string {
  switch (body.kind) {
    case "invite":
      return `${who} sent an invite: "${body.payload.title}"`;
    case "move":
      return `${who} moved a meeting to ${body.payload.startISO}`;
    case "cancel":
      return `${who} cancelled a meeting`;
    case "rsvp":
      return `${who} ${body.payload.response} an invite`;
  }
}

function attioLabel(body: AttioBeatBody, who: string): string {
  switch (body.kind) {
    case "record":
      return `${who} added a ${body.payload.object} record to the CRM`;
    case "update":
      return `${who} changed "${body.payload.recordRef}" in the CRM`;
    case "note":
      return `${who} logged a note: "${body.payload.title}"`;
    case "task":
      return `${who} raised a follow-up: "${body.payload.content}"`;
  }
}

function docsLabel(body: GoogleDocsBeatBody, who: string): string {
  switch (body.kind) {
    case "document":
      return `${who} shared a document: "${body.payload.title}"`;
    case "append":
      return `${who} added a section to "${body.payload.documentRef}"`;
    case "replace":
      return `${who} revised "${body.payload.find}" in "${body.payload.documentRef}"`;
  }
}

// ---------------------------------------------------------------------------
// What the agent is told
// ---------------------------------------------------------------------------

/**
 * The nudge, not the news.
 *
 * The digest says a surface changed and nothing about what it says. That is the
 * point of the whole exercise: an agent that is handed the subject line and the
 * body has not had to read anything, and "acted without reading" — the first mode
 * in the failure catalog — becomes unobservable. Told only that mail arrived, an
 * agent that acts on it without opening it has demonstrably guessed.
 */
export function tickDigest(beats: BeatFired[], events: DirectorEvent[]): string {
  const counts = tallyLanded(beats, events);
  if (counts.size === 0) return "Nothing new has arrived since the last check.";
  return [...counts.entries()]
    .map(([what, n]) => (n > 1 ? `${n}× ${what}` : what))
    .join("; ");
}

/**
 * Phrase the agent will be told → how many times it happened this tick, in first
 * occurrence order. Split out from the rendering because the *choice of phrase*
 * is the load-bearing part (see above) and has to be assertable on its own: a
 * phrase that leaked a subject line would be a scoring bug, not a wording one.
 *
 * Only things that landed count. A beat whose injection failed did not happen,
 * and telling the agent to go and look for it would be a lie the twin cannot
 * back up.
 */
export function tallyLanded(
  beats: BeatFired[],
  events: DirectorEvent[],
): Map<string, number> {
  const counts = new Map<string, number>();
  const landed = [
    ...beats.filter((b) => !b.error).map((b) => ({ twin: b.twin, kind: b.kind })),
    ...events.filter((e) => !e.error).map((e) => ({ twin: e.twin, kind: e.kind })),
  ];

  for (const item of landed) {
    const what = digestPhrase(item.twin, item.kind);
    counts.set(what, (counts.get(what) ?? 0) + 1);
  }
  return counts;
}

/**
 * What the agent is told about one landed thing — a surface and no more.
 *
 * A switch over the twin rather than a chain of ternaries, because the chain
 * ended in an `else` that said "a change on the calendar": every twin added
 * after it silently announced itself as the diary, and the agent would have gone
 * looking for a meeting that a CRM note had caused. An exhaustive switch makes
 * the next twin a typecheck failure instead of a wrong sentence.
 */
function digestPhrase(twin: TwinName, kind: string): string {
  switch (twin) {
    case "gmail":
      return "new mail in the inbox";
    case "slack":
      return kind === "reaction" ? "a new reaction in Slack" : "new activity in Slack";
    case "calendar":
      return "a change on the calendar";
    case "attio":
      return "a change in the CRM";
    case "google-docs":
      return "a change in a document";
  }
}

/** The tail of the story, for the director's prompt. Oldest first. */
export function recentHistory(ticks: TickRecord[], max: number): TimelineEntry[] {
  const all = runTimeline(ticks);
  return max >= all.length ? all : all.slice(all.length - max);
}
