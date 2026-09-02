import type { AgentTrace, JudgeStep, ToolCall, TwinName } from "@sonata/core";

// Shrink a run trace to the part a judge can reason about — apps/gmail's
// src/lib/eval/judge/project.ts, generalized to three surfaces.
//
// The trace's `llmCalls` hold verbatim OpenRouter request bodies, and each body
// carries the whole conversation so far, so a day's trace runs to megabytes.
// Handing that to the judge would blow its context before it read a single
// finding. What survives here: what the agent did (tool calls, results collapsed
// to a line) and which surface it did it on. What goes: every request body, every
// tool payload, every token block.
//
// Each adapter calls this for its own twin, so a Slack finding cannot cite a
// Gmail step and the judge's evidence stays attributable.

/** Cap on a projected tool result. Past this a result is a payload, not a signal. */
const MAX_SUMMARY = 300;

/** Unknown tools get raw JSON, kept short: nothing here knows what matters in it. */
const MAX_UNKNOWN = 200;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Tool results are `unknown` and shaped by whatever the twin returned. */
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function count(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function json(v: unknown): string {
  const s = JSON.stringify(v);
  return typeof s === "string" ? s : String(v);
}

/**
 * How a mutation reads once it has landed. The returned id proves the write
 * happened and is what a finding cites; the rest of a twin's response is echoed
 * input, which the judge already has in `args`.
 */
const MUTATION_VERB: Record<string, string> = {
  // gmail
  create_label: "created label",
  modify_labels: "modified labels on",
  archive: "archived",
  trash: "trashed",
  send_reply: "sent reply on",
  reply_all: "sent reply-all on",
  forward: "forwarded",
  create_draft: "drafted (unsent)",
  // slack
  send_message: "posted in",
  reply_in_thread: "replied in thread on",
  add_reaction: "reacted to",
  // calendar
  create_event: "created event",
  update_event: "updated event",
  delete_event: "cancelled event",
  // attio
  create_record: "created record",
  update_record: "updated record",
  create_note: "logged note on",
  create_task: "raised task",
  complete_task: "completed task",
  // google-docs
  create_document: "created document",
  append_paragraph: "appended to document",
  replace_text: "replaced text in document",
  // harness-local
  escalate_to_owner: "escalated to the owner",
};

/**
 * Where a twin puts the id of the thing a write just made or moved, most
 * specific first.
 *
 * A list rather than a chain of `||` because no two of the five twins agree:
 * Gmail answers `id`, Slack `ts`, the CRM `recordId` / `noteId` / `taskId`, Docs
 * `documentId`. A verb printed with no id behind it is a line the judge cannot
 * cite — "created record" names nothing a diff can be checked against — so the
 * cost of a missing entry here is a finding with no evidence under it.
 */
const RESULT_ID_FIELDS = [
  "id",
  "draftId",
  "ts",
  "eventId",
  "messageId",
  "recordId",
  "noteId",
  "taskId",
  "documentId",
];

function idIn(r: Record<string, unknown>): string {
  for (const field of RESULT_ID_FIELDS) {
    const value = text(r[field]);
    if (value) return value;
  }
  return "";
}

function confirmation(name: string, r: Record<string, unknown>): string {
  const verb = MUTATION_VERB[name] ?? name;
  const id = idIn(r);
  const head = id ? `${verb} ${id}` : verb;

  const attrs: string[] = [];
  if (text(r.name)) attrs.push(`name "${text(r.name)}"`);
  const labels = strings(r.labelIds);
  if (labels.length) attrs.push(`labels: ${labels.join(", ")}`);
  if (text(r.channel)) attrs.push(`channel ${text(r.channel)}`);
  const threadId = text(r.threadId);
  if (threadId && threadId !== id) attrs.push(`thread ${threadId}`);
  if (text(r.start)) attrs.push(`starts ${text(r.start)}`);
  // What the write actually said, on the surfaces where the id alone is opaque:
  // "created record cd0f…" is unreadable next to "created record cd0f… —
  // titled "Northwind Retail"", and the title is what every criterion names.
  if (text(r.title)) attrs.push(`titled "${text(r.title)}"`);
  if (typeof r.occurrencesChanged === "number") {
    attrs.push(`${r.occurrencesChanged} occurrence(s)`);
  }

  return attrs.length ? `${head} — ${attrs.join(", ")}` : head;
}

/**
 * One line per tool call. Reads collapse to their shape — a count, a subject, a
 * sender — because the judge needs to know *that* the agent looked and at what,
 * while what it read is already visible through the twin's diff.
 */
export function summarize(call: ToolCall): string {
  // A failed call wrote nothing and returned nothing worth reading.
  if (call.error) return truncate(`error: ${call.error}`, MAX_SUMMARY);

  // Some failures arrive in the payload rather than as a throw — Slack answers
  // every error with HTTP 200 and `{ok: false}`. Without this the summary reads
  // "posted in #ops" for a post that never happened.
  const r = obj(call.result);
  if (text(r.error)) return truncate(`error: ${text(r.error)}`, MAX_SUMMARY);
  if (r.ok === false) return truncate(`error: ${text(r.error) || "not ok"}`, MAX_SUMMARY);

  switch (call.name) {
    case "list_messages":
      return `${count(r.messages)} messages`;
    case "get_thread": {
      const first = obj(Array.isArray(r.messages) ? r.messages[0] : undefined);
      return truncate(
        `thread ${text(r.threadId)}: ${count(r.messages)} messages, subject "${text(first.subject)}"`,
        MAX_SUMMARY,
      );
    }
    case "get_message":
      return truncate(`from ${text(r.from)} — subject "${text(r.subject)}"`, MAX_SUMMARY);
    case "list_labels":
      return `${count(r.labels)} labels`;
    case "list_channels":
      return `${count(r.channels)} channels`;
    case "get_channel_history":
      return truncate(`${count(r.messages)} messages in ${text(r.channel)}`, MAX_SUMMARY);
    case "get_thread_replies":
      return `${count(r.messages)} replies`;
    case "get_user":
      return truncate(`${text(r.name)} — ${text(r.title)}`, MAX_SUMMARY);
    case "search_messages":
      return `${count(r.matches)} matches`;
    case "list_calendars":
      return `${count(r.calendars)} calendars`;
    case "list_events":
      return `${count(r.events)} events`;
    case "get_event":
      return truncate(`"${text(r.summary)}" ${text(r.start)}–${text(r.end)}`, MAX_SUMMARY);
    case "find_free_time":
      return `${count(r.free)} free windows`;
    case "search_records":
      return truncate(`${count(r.records)} ${text(r.object) || "records"}`, MAX_SUMMARY);
    case "get_record":
      return truncate(`${text(r.object)} "${text(r.title)}"`, MAX_SUMMARY);
    case "list_notes":
      return `${count(r.notes)} notes`;
    case "list_tasks":
      return `${count(r.tasks)} tasks`;
    case "read_document":
      return truncate(
        `"${text(r.title)}": ${count(r.paragraphs)} paragraphs, ${text(r.revisionId)}`,
        MAX_SUMMARY,
      );
    default:
      if (call.isMutation) return truncate(confirmation(call.name, r), MAX_SUMMARY);
      // A tool this file has never heard of — a custom agent's, or one added
      // since. Better a clipped blob than nothing.
      return truncate(json(call.result), MAX_UNKNOWN);
  }
}

/** This twin's calls, oldest first, shrunk to judge steps. */
export function projectTwinTrace(trace: AgentTrace, twin: TwinName): JudgeStep[] {
  return [...trace.toolCalls]
    .filter((c) => c.twin === twin)
    .sort((a, b) => a.seq - b.seq)
    .map((c) => ({
      seq: c.seq,
      ...(c.tick === undefined ? {} : { tick: c.tick }),
      twin,
      name: c.name,
      args: c.args,
      resultSummary: summarize(c),
      isMutation: c.isMutation,
      ...(c.error ? { error: c.error } : {}),
    }));
}

/** Harness-local calls — escalations and anything else with no twin behind it. */
export function projectHarnessTrace(trace: AgentTrace): JudgeStep[] {
  return [...trace.toolCalls]
    .filter((c) => !c.twin)
    .sort((a, b) => a.seq - b.seq)
    .map((c) => ({
      seq: c.seq,
      ...(c.tick === undefined ? {} : { tick: c.tick }),
      twin: null,
      name: c.name,
      args: c.args,
      resultSummary: summarize(c),
      isMutation: c.isMutation,
      ...(c.error ? { error: c.error } : {}),
    }));
}
