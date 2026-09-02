import type { InjectedRef, TimelineEntry, TwinName } from "@sonata/core";

// Two scripted control agents, and the interface they implement.
//
// Controls are how you find out whether the scoring works. A benchmark that cannot
// distinguish a good model from an agent that does literally nothing is measuring
// noise, and the only way to know is to run the nothing-agent and look at the number.
// This pair brackets the range from below:
//
//   `doNothingAgent`        must score ~0 autonomy on every episode. It never calls a
//                           tool, so completion is 0 and momentum is 0 (every working
//                           tick is a stall). If it scores well, the checklist is
//                           passing criteria the world satisfied on its own.
//
//   `replyToEverythingAgent` is busy and wrong: it answers every single thing that
//                           arrives, without reading history, with a content-free
//                           acknowledgement. It should score high on momentum and
//                           independence and LOW overall — and it should trip
//                           `bulk-swept`, `acted-without-reading` and `replied-on-guess`
//                           in the judge. If the judge finds nothing on this agent, the
//                           prompt is not looking at what the agent wrote.
//
// This is the same known-bad-control trick that validated the Gmail rubric
// (`naiveArchiveAgent` in apps/gmail/src/lib/eval/agents.ts), extended to a whole day.
//
// The interface below is the agent's side of the engine's tick loop, defined here
// because a control has to be written against something. An engine that shapes its
// loop differently should adapt these two in this file and nowhere else.

/** One tool the engine exposes to the agent, already bound to a twin. */
export interface AgentTool {
  name: string;
  twin: TwinName | null;
  description: string;
  call(args: Record<string, unknown>): Promise<unknown>;
}

/** Something the world put in front of the agent this tick, with a handle to act on. */
export interface Arrival {
  entry: TimelineEntry;
  /** What the twin created — the thread, message or event this arrival IS. */
  handle?: InjectedRef;
}

export interface EpisodeAgentContext {
  tick: number;
  /** Simulated time at the start of this tick. Never wall-clock. */
  simTimeISO: string;
  /** The standing brief, handed over at tick 0 and unchanged after. */
  task: string;
  arrivals: Arrival[];
  tools: AgentTool[];
  /** Think out loud. Recorded as an `AgentStep` of kind `thought`. */
  note(text: string): void;
  /**
   * Hand the job back to a human. Its own channel rather than a tool call because
   * autonomy is the headline score: escalation has to be countable, not inferred.
   */
  escalate(text: string): void;
}

export interface EpisodeAgent {
  readonly name: string;
  /** Called once per tick, in order, until the day ends. */
  tick(ctx: EpisodeAgentContext): Promise<void>;
  /** Its closing account of the day, if it has one. */
  finish?(): Promise<string | undefined>;
}

/**
 * The floor control. It reads nothing, writes nothing and never escalates — a human
 * would have had to do all of it, and the score has to say so.
 */
export function doNothingAgent(): EpisodeAgent {
  return {
    name: "do-nothing(control)",
    async tick() {
      // Deliberately empty. Not even a `note`: a thought is not an action, but
      // emitting one would make the run artifact look busier than the day was.
    },
    async finish() {
      return undefined;
    },
  };
}

/** Tool names that mean "answer this", in the order a twin is likely to offer them. */
const REPLY_TOOLS: Record<TwinName, string[]> = {
  gmail: ["send_reply", "reply", "reply_all", "send_message", "send"],
  slack: ["post_message", "reply_in_thread", "chat_postMessage", "send_message"],
  calendar: ["rsvp", "respond", "update_event"],
  // Nothing on these two answers a person: a CRM note and a document edit are
  // both statements about the world rather than replies to it. The empty list
  // falls through to the mutating-verb search below, which is the right
  // behaviour — this control's job is to make the agent act, not to insist the
  // action is a reply.
  attio: [],
  "google-docs": [],
};

/** The argument name each twin's reply tool wants its prose under. */
const BODY_ARG: Record<TwinName, string> = {
  gmail: "body",
  slack: "text",
  calendar: "comment",
  attio: "content",
  "google-docs": "text",
};

/** What it says every single time, to everyone, about everything. */
const CANNED = "Thanks for the update — noted, and I'll take it from here.";

function pickTool(tools: AgentTool[], twin: TwinName): AgentTool | undefined {
  for (const name of REPLY_TOOLS[twin]) {
    const tool = tools.find((t) => t.twin === twin && t.name === name);
    if (tool) return tool;
  }
  // Fall back to any mutating-looking tool on that twin, so this control keeps
  // working when a twin renames its verbs.
  return tools.find((t) => t.twin === twin && /send|post|reply|create/i.test(t.name));
}

export interface ReplyToEverythingOptions {
  /** Overrides the canned line — useful for a variant that invents facts on purpose. */
  text?: string;
  /** Bound on replies per tick, so a chatty day cannot run away with the budget. */
  maxPerTick?: number;
}

/**
 * The busy-but-wrong control. Replies to every arrival, immediately, with the same
 * sentence, having read nothing. High activity, near-zero judgement — exactly the
 * shape of agent an activity-based score would flatter and this one must not.
 */
export function replyToEverythingAgent(opts: ReplyToEverythingOptions = {}): EpisodeAgent {
  const text = opts.text ?? CANNED;
  const maxPerTick = opts.maxPerTick ?? 10;
  let replies = 0;

  return {
    name: "reply-to-everything(control)",
    async tick(ctx) {
      let sent = 0;
      for (const arrival of ctx.arrivals) {
        if (sent >= maxPerTick) break;
        const twin = arrival.entry.twin;
        // Only the world's own moves are answered — replying to its own actions
        // would have it talking to itself for the rest of the day.
        if (!twin || arrival.entry.source === "agent" || !arrival.handle) continue;

        const tool = pickTool(ctx.tools, twin);
        if (!tool) continue;

        // Every identifier the twins use, passed together: the control cannot know
        // which one this tool wants, and a rejected call is a wasted control run.
        await tool.call({
          [BODY_ARG[twin]]: text,
          messageId: arrival.handle.id,
          threadId: arrival.handle.containerId ?? arrival.handle.id,
          eventId: arrival.handle.id,
          channel: arrival.handle.containerId ?? arrival.handle.id,
          ts: arrival.handle.id,
        });
        sent += 1;
        replies += 1;
      }
    },
    async finish() {
      return `Replied to everything that came in — ${replies} message(s) in all.`;
    },
  };
}
