import { buildTools, callTool, type ServedTwin, type SonataConfig } from "@sonata/mcp";
import { TWIN_LABELS } from "@/lib/twins";

// "Test the connection": the same handshake the user's agent is about to make,
// made from here first.
//
// It goes through @sonata/mcp's own `buildTools` and `callTool` — the exact
// dispatcher the stdio server hands a tools/call to — rather than fetching the
// twins directly. That matters: a direct fetch would prove the twins are up,
// which the cards above already say, and prove nothing about the thing the user
// is being asked to trust. This proves the whole path, including the failure
// text, which is the part they will actually read if it goes wrong.

const DAY_MS = 86_400_000;

/** How far ahead the calendar probe looks. A month is what "what's in it" means. */
const CALENDAR_DAYS = 30;

/** Enough to count a seeded mailbox without paging. */
const INBOX_SCAN = 100;

/**
 * A button that might sit for ninety seconds is a button nobody presses twice.
 * The connector's own client waits thirty per call because an agent mid-task
 * would rather wait than fail; a person watching a spinner would not.
 */
const PROBE_TIMEOUT_MS = 8000;

export interface ConnectCheck {
  twin: ServedTwin;
  label: string;
  /** The tool name as the agent sees it: `gmail_list_messages`. */
  tool: string;
  ok: boolean;
  /** "14 messages in the inbox" — or the sentence the agent would have been handed. */
  detail: string;
  ms: number;
}

export interface ConnectTest {
  at: number;
  ok: boolean;
  /** Every tool the connector serves, whether or not its twin answered. */
  toolTotal: number;
  twinsReached: number;
  twinsTried: number;
  /** One line to put in front of the user. */
  headline: string;
  checks: ConnectCheck[];
}

interface Probe {
  twin: ServedTwin;
  tool: string;
  args(now: number): Record<string, unknown>;
  /** Turn the tool's own JSON into the phrase that goes in the headline. */
  describe(payload: unknown): string;
}

function countOf(payload: unknown, key: string): number {
  if (typeof payload !== "object" || payload === null) return 0;
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.length : 0;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// One read per twin. Reads only: pressing a test button must never leave an audit
// row, because the audit log is the evidence the judge scores and this is not the
// agent's work.
const PROBES: readonly Probe[] = [
  {
    twin: "gmail",
    tool: "gmail_list_messages",
    args: () => ({ labelIds: ["INBOX"], maxResults: INBOX_SCAN }),
    describe: (p) => `${plural(countOf(p, "messages"), "message", "messages")} in the inbox`,
  },
  {
    twin: "slack",
    tool: "slack_list_channels",
    args: () => ({}),
    describe: (p) => plural(countOf(p, "channels"), "channel", "channels"),
  },
  {
    twin: "calendar",
    tool: "calendar_list_events",
    args: (now) => ({
      timeMin: new Date(now).toISOString(),
      timeMax: new Date(now + CALENDAR_DAYS * DAY_MS).toISOString(),
      maxResults: 50,
    }),
    describe: (p) =>
      `${plural(countOf(p, "events"), "event", "events")} in the next ${CALENDAR_DAYS} days`,
  },
];

/** The first text block of a tool result — the only shape these tools return. */
function textOf(content: readonly { type: string }[]): string {
  for (const block of content) {
    if (block.type === "text" && "text" in block) return String((block as { text: unknown }).text);
  }
  return "";
}

/** A fetch with a shorter fuse, layered over whatever deadline the caller already set. */
function impatientFetch(ms: number): typeof globalThis.fetch {
  return (input, init) => {
    const deadline = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return globalThis.fetch(input, { ...init, signal });
  };
}

function sentenceList(parts: readonly string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function headlineFor(checks: readonly ConnectCheck[], toolTotal: number): string {
  const reached = checks.filter((c) => c.ok);
  const missing = checks.filter((c) => !c.ok);

  if (reached.length === 0) {
    return "No clone answered, so there is nothing for an agent to work with yet. Start them above, then test again.";
  }

  const saw = `${plural(reached.length, "clone", "clones")}, ${plural(toolTotal, "tool", "tools")}, ${sentenceList(
    reached.map((c) => c.detail),
  )}`;

  if (missing.length === 0) return `Your agent will see ${saw}.`;
  // Named, not counted: "one clone is down" sends the user hunting for which.
  return `Your agent will see ${saw} — but ${sentenceList(missing.map((c) => c.label))} did not answer, so those tools will fail.`;
}

/**
 * Run the handshake. Never throws: every way this can go wrong is a sentence the
 * user needs to read, and an exception here would replace all three of them with
 * a stack trace.
 */
export async function runHandshake(config: SonataConfig, at = Date.now()): Promise<ConnectTest> {
  const { entries } = buildTools({ config, fetchImpl: impatientFetch(PROBE_TIMEOUT_MS) });
  const baseUrlFor = (twin: ServedTwin) => config.urls[twin];

  // In parallel: the three twins are independent processes, and a serial probe
  // makes one slow clone look like three.
  const checks = await Promise.all(
    PROBES.map(async (probe): Promise<ConnectCheck> => {
      const started = Date.now();
      const result = await callTool(entries, probe.tool, probe.args(at), baseUrlFor);
      const text = textOf(result.content);
      const ms = Date.now() - started;
      const base = { twin: probe.twin, label: TWIN_LABELS[probe.twin], tool: probe.tool, ms };

      if (result.isError) return { ...base, ok: false, detail: text || "the call failed" };
      try {
        return { ...base, ok: true, detail: probe.describe(JSON.parse(text) as unknown) };
      } catch {
        // The tool answered but not with JSON. That is the connector's problem,
        // not the user's, so say what happened rather than what it should have.
        return { ...base, ok: false, detail: `answered with something that is not JSON: ${text.slice(0, 160)}` };
      }
    }),
  );

  const twinsReached = checks.filter((c) => c.ok).length;
  return {
    at,
    ok: twinsReached === checks.length,
    toolTotal: entries.length,
    twinsReached,
    twinsTried: checks.length,
    headline: headlineFor(checks, entries.length),
    checks,
  };
}
