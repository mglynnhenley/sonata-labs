import { owner, offsetMinutes, type AgentStep, type EpisodeSpec, type ToolCall } from "@sonata/core";
import { chatComplete, type ChatComplete, type Effort, type OpenAI } from "./llm";
import { recordAgentSummary, recordToolCall, withTick } from "./trace";
import { summarize } from "./project";
import { errorMessage } from "./http";
import { fn, type EngineTool, type ToolInput } from "./tools/types";
import { createOpenItems, describeOpenItems, OPEN_ITEMS_TOOL } from "./tools/openItems";

// THE AGENT UNDER TEST.
//
// A reference implementation, not the product: any model can be swapped in by
// changing a slug, and a customer's own agent can replace this file entirely by
// implementing `Agent`. What must not change is the shape of what comes out —
// `AgentStep[]` per tick — because that is what the timeline, the checklist and
// the autonomy score all read.
//
// Two decisions here are load-bearing:
//
//   - ONE CONVERSATION FOR THE WHOLE DAY. The message list survives across ticks,
//     so at 14:00 the agent still remembers the 09:15 email. An agent handed a
//     fresh context each tick cannot fail at continuity, and continuity is one of
//     the failure modes being measured.
//   - THE TICK PROMPT SAYS ALMOST NOTHING. It says the time and that something
//     arrived, never what arrived (see `tickDigest`). An agent that acts on a mail
//     it never opened has demonstrably guessed, and that only stays observable if
//     the prompt withholds the contents.
//   - THE PROMPT ALSO SAYS WHAT IS STILL OPEN. Arrivals alone are a description of
//     the world, not of the job: everything already read is invisible in them, so
//     an answer to a reply the agent sent two hours ago lands on an agent with no
//     record of having sent it. The list is the agent's own (see
//     `tools/openItems.ts`) — the harness carries it and shows it back, and infers
//     nothing on the agent's behalf.
//
// CHANGES THE MEASURED SURFACE. The open-items list altered what the agent is
// shown each tick, so continuity and stall numbers from runs before it are not
// comparable with runs after it. Compare within an era, not across the change.

/**
 * Runaway backstop, not a work budget.
 *
 * The agent ends its own tick: the loop returns the moment a reply carries no
 * tool calls, which is what "I am done for now" looks like on this wire. This
 * number only bites an agent that never says that — one looping on reads, or
 * re-listing the same inbox forever.
 *
 * It was 12, chosen as a realism cap ("a tick is fifteen minutes, not a whole
 * afternoon"), and at 12 it stopped being a backstop and became the exit path.
 * Tool calls are finer-grained than actions — list, get thread, get message is
 * three calls to read ONE email — so twelve is about four real moves, and a
 * competent agent hit the wall mid-thought every tick. That measures step
 * budgeting, not the job, and it floors every model at the same place.
 *
 * 40 leaves room for a busy quarter of an hour (read a handful of threads,
 * write two replies, move a meeting) while still stopping a loop. Spend is
 * guarded independently by `Termination.maxCostUsd`, so this does not have to
 * be the thing that protects the bill.
 *
 * CHANGES THE MEASURED SURFACE: an agent that stalled on the old cap can now
 * finish its thought, so continuity and stall numbers are not comparable across
 * this change. Compare within an era.
 */
export const DEFAULT_MAX_STEPS = 40;

const ESCALATE = "escalate_to_owner";

/**
 * CONTEXT POLICY. One conversation for the whole day is the point of this agent,
 * and it is also how a day dies: a workbook read is ~60k characters, an inbox
 * read a few thousand, and a model that reads the workbook every interval
 * carries all of it forward until the provider refuses the prompt (a 36-tick
 * tax day hit 215k tokens at tick 14 and returned 400). So:
 *
 *   - A tool result older than the current interval is shortened to its head
 *     once it is longer than `keptToolChars`. The stub says so and says how to
 *     get the data back; the model re-reads, the way a person re-opens a file.
 *     The current interval's results stay whole — the model is still using them.
 *   - If the conversation is still longer than `maxHistoryChars`, the oldest
 *     intervals are dropped whole (prompt, replies and tool results together, so
 *     no tool call is left without its result). A note at the top says which.
 *
 * Both are declared here rather than buried, because they are part of what is
 * measured: an agent that forgets is an agent under this policy. The trace shows
 * exactly what the model was sent. Compare runs within the same policy.
 */
export interface AgentContextPolicy {
  /** Earlier-interval tool results longer than this (characters) become a stub. */
  keptToolChars: number;
  /** Ceiling for the whole conversation, in characters (~4 per token). */
  maxHistoryChars: number;
}

export const DEFAULT_CONTEXT_POLICY: AgentContextPolicy = {
  keptToolChars: 4_000,
  // ~90k tokens: room for the current interval's reads under a 200k window.
  maxHistoryChars: 360_000,
};

const ELIDED_MARK = "[elided from context";
/** How much of a shortened result survives: enough to see what it was. */
const STUB_HEAD_CHARS = 600;

function stubResult(content: string, keptToolChars: number): string {
  const head = content.slice(0, Math.min(STUB_HEAD_CHARS, keptToolChars));
  return `${head}\n… ${ELIDED_MARK}: ${content.length - head.length} more characters of this result from an earlier interval were removed to keep the conversation within the model's limit. Call the tool again for the current data.]`;
}

function messageChars(messages: readonly OpenAI.ChatCompletionMessageParam[]): number {
  let n = 0;
  for (const m of messages) n += JSON.stringify(m).length;
  return n;
}

interface Compaction {
  shortened: number;
  /** Interval labels whose messages were dropped, oldest first. */
  dropped: string[];
}

/**
 * Apply the policy in place. `intervals` are the message indices where each
 * past interval's prompt sits, with its label; both are updated as messages go.
 */
function compactHistory(
  messages: OpenAI.ChatCompletionMessageParam[],
  intervals: Array<{ at: number; label: string }>,
  policy: AgentContextPolicy,
): Compaction {
  let shortened = 0;
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    if (m.content.length <= policy.keptToolChars || m.content.includes(ELIDED_MARK)) continue;
    m.content = stubResult(m.content, policy.keptToolChars);
    shortened++;
  }
  const dropped: string[] = [];
  // Never drop the interval that was just asked for: the newest one stays.
  while (intervals.length > 1 && messageChars(messages) > policy.maxHistoryChars) {
    const [oldest, next] = [intervals[0]!, intervals[1]!];
    const count = next.at - oldest.at;
    messages.splice(oldest.at, count);
    dropped.push(oldest.label);
    intervals.shift();
    for (const i of intervals) i.at -= count;
  }
  return { shortened, dropped };
}

export interface AgentContext {
  tick: number;
  /** "09:15" — what the people in the world would say the time is. */
  simTimeLabel: string;
  simTimeISO: string;
  /** What changed since the last tick, and nothing about what it says. */
  digest: string;
  /** Ticks remaining after this one, so the agent can pace the day. */
  ticksLeft: number;
}

export interface Agent {
  /** Everything the agent did this tick. Provider failures preserve partial steps in AgentCallError. */
  act(ctx: AgentContext): Promise<AgentStep[]>;
  /** The agent's closing account of its own day, for the judge. */
  wrapUp(): Promise<string>;
}

export class AgentCallError extends Error {
  constructor(message: string, readonly steps: AgentStep[]) {
    super(`Agent model call failed: ${message}`);
    this.name = "AgentCallError";
  }
}

export interface AgentOptions {
  spec: EpisodeSpec;
  tools: EngineTool[];
  /** OpenRouter slug of the model under test. */
  model?: string;
  effort?: Effort;
  /** The model seam. Tests pass a stub; a run passes `chatComplete`. */
  chat?: ChatComplete;
  maxStepsPerTick?: number;
  /** How the day's conversation is kept within the model's window. */
  contextPolicy?: Partial<AgentContextPolicy>;
  /** Actual tool executions, including reads and local notes. */
  maxToolCallsPerTick?: number;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function agentSystemPrompt(spec: EpisodeSpec, tools: EngineTool[]): string {
  const me = owner(spec.world);
  const twins = [...new Set(tools.map((t) => t.twin).filter((t): t is NonNullable<typeof t> => !!t))];
  return [
    `You are ${me.name}'s assistant at ${spec.world.business.name}, working a normal day.`,
    `You operate ${me.name}'s own accounts: ${me.email}${
      twins.length ? ` (${twins.join(", ")})` : ""
    }. Anything you send goes out under that name.`,
    "",
    "YOUR JOB",
    spec.task,
    "",
    "HOW THE DAY WORKS",
    "- The day runs in short intervals. Each turn you are told the time and whether anything",
    "  new has arrived — never what it says. Go and read it before you act on it.",
    "- Do the work. Do not narrate a plan and stop; a turn that ends with no tool call is a",
    "  turn in which nothing happened.",
    "- When there is genuinely nothing to do, say so in one line and stop. Inventing work is",
    "  worse than idling.",
    `- ${ESCALATE} reports a blocker requiring human help. Explain what is blocked and what you need.`,
    "- Routine technical reviews and required approvals are part of the job. Request them through",
    "  the normal communication tools and continue other useful work while waiting.",
    `- ${OPEN_ITEMS_TOOL} is your own running list of what you have started and not finished.`,
    "  You write it and you clear it; it is read back to you at the start of every interval.",
    "  Nobody else sees it and it changes nothing in your accounts.",
    "- You are an AI assistant working alongside people. Do not claim human attendance or approval you do not have.",
  ].join("\n");
}

/**
 * Three things, in this order and always all three: the time, what is NEW, and
 * what is STILL OPEN.
 *
 * Both middle and last are printed even when empty, and that is the whole point.
 * A tick that says only "Nothing new has arrived" is read as "nothing to do",
 * which is exactly the read that manufactures a stall; the same tick with the
 * agent's own unfinished list under it says something true and quite different.
 */
function tickPrompt(ctx: AgentContext, openBlock: string, first: boolean, spec: EpisodeSpec): string {
  const offset = offsetMinutes(spec.clock.startISO);
  const localDate = new Date(Date.parse(ctx.simTimeISO) + offset * 60_000).toISOString().slice(0, 10);
  const zone = spec.clock.startISO.match(/(?:Z|[+-]\d{2}:?\d{2})$/)![0];
  const head = `It is ${ctx.simTimeLabel} on ${localDate} (UTC${zone === "Z" ? "+00:00" : zone}).\n` +
    `Simulated instant: ${ctx.simTimeISO}. Each interval is ${spec.clock.simMinutesPerTick} minutes.\n` +
    `NEW — ${ctx.digest}\n${openBlock}`;
  const opening = first ? "\n\nThis is the start of your day. Get oriented, then get to work." : "";
  const closing = ctx.ticksLeft === 0 ? "\n\nThis is the last interval of the day. Finish anything outstanding." : "";
  return head + opening + closing;
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

function parseArgs(raw: string | undefined): ToolInput {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ToolInput)
      : {};
  } catch {
    // A model that emits malformed arguments has made a mistake worth seeing in
    // the trace, not one worth ending the day over.
    return {};
  }
}

/** The one harness-local tool. It touches no twin, so it leaves no audit row. */
function escalationTool(ownerName: string): EngineTool {
  return {
    name: ESCALATE,
    twin: null,
    isMutation: true,
    def: fn(
      ESCALATE,
      `Hand this back to ${ownerName} because you cannot safely finish it yourself. ` +
        "Say what is blocked and what you would need to proceed.",
      {
        type: "object",
        properties: {
          reason: { type: "string", description: "What is blocked, and what you need." },
        },
        required: ["reason"],
      },
    ),
    run(args: ToolInput) {
      return Promise.resolve({ escalated: true, reason: args.reason });
    },
  };
}

export function createAgent(opts: AgentOptions): Agent {
  const { spec } = opts;
  const chat = opts.chat ?? chatComplete;
  const maxSteps = Math.max(1, opts.maxStepsPerTick ?? DEFAULT_MAX_STEPS);
  const openItems = createOpenItems();
  const tools = [...opts.tools, escalationTool(owner(spec.world).name), openItems.tool];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const defs = tools.map((t) => t.def);

  const policy: AgentContextPolicy = { ...DEFAULT_CONTEXT_POLICY, ...opts.contextPolicy };
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: agentSystemPrompt(spec, opts.tools) },
  ];
  /** Where each interval's prompt sits in `messages`, so whole ones can go. */
  const intervals: Array<{ at: number; label: string }> = [];
  /** Intervals dropped so far, kept so the note at the top stays cumulative. */
  const droppedSoFar: string[] = [];
  let seq = 0;
  let first = true;

  /** Trim before asking the model; returns the line the prompt should carry, if any. */
  function trimForPrompt(): string | null {
    const { shortened, dropped } = compactHistory(messages, intervals, policy);
    droppedSoFar.push(...dropped);
    if (droppedSoFar.length) {
      const note = `[Intervals ${droppedSoFar[0]}–${droppedSoFar[droppedSoFar.length - 1]} were removed from your context to fit the model's limit. Your open-items list still records what you started; re-read your accounts for detail.]`;
      // One note, kept right after the system prompt and rewritten as it grows.
      const existing = messages[1];
      if (existing?.role === "user" && String(existing.content).startsWith("[Intervals ")) existing.content = note;
      else {
        messages.splice(1, 0, { role: "user", content: note });
        for (const i of intervals) i.at += 1;
      }
    }
    if (!shortened && !dropped.length) return null;
    const parts = [];
    if (shortened) parts.push(`${shortened} earlier tool result${shortened === 1 ? "" : "s"} shortened`);
    if (dropped.length) parts.push(`${dropped.length} earlier interval${dropped.length === 1 ? "" : "s"} removed`);
    return `CONTEXT — ${parts.join("; ")}. Re-read a workbook or message if you need its detail again.`;
  }

  /** Run one tool, recording it in the trace and as a step, and never throwing. */
  async function invoke(name: string, args: ToolInput): Promise<{ step: AgentStep; result: unknown }> {
    const tool = byName.get(name);
    const startedAt = Date.now();
    if (!tool) {
      // A hallucinated tool name is the model's error, and it has to be able to
      // see that: the result goes back into the conversation, not to a crash.
      const error = `no such tool: ${name}`;
      return {
        step: { kind: "tool", seq: seq++, at: startedAt, twin: null, name, args, resultSummary: error, isMutation: false, error },
        result: { error },
      };
    }

    let result: unknown;
    let error: string | undefined;
    try {
      result = await tool.run(args);
    } catch (err) {
      error = errorMessage(err);
      result = { error };
    }
    const endedAt = Date.now();

    // BOOKKEEPING IS NOT AN ACT. The open-items list touches no twin and nobody
    // in the world can see it, so recording it as a tool step would inflate every
    // count that reads one: `didSomething` would call a tick busy that was spent
    // writing notes, the autonomy score would bank a note as a read, and the run
    // would stop looking idle without a thing having happened. It lands in the
    // record as what it is — the agent thinking out loud — and never in the trace's
    // tool calls.
    if (name === OPEN_ITEMS_TOOL && !error) {
      const { added, closed } = openItems.lastCall();
      return {
        step: { kind: "thought", seq: seq++, at: endedAt, text: describeOpenItems(added, closed) },
        result,
      };
    }

    const call: ToolCall = {
      seq: 0,
      name,
      args,
      result,
      isMutation: tool.isMutation,
      startedAt,
      endedAt,
      actionIds: [],
      ...(tool.twin ? { twin: tool.twin } : {}),
      ...(error ? { error } : {}),
    };
    // `seq` and `actionIds` are the trace's to assign; recordToolCall stamps them.
    recordToolCall({
      name,
      args,
      result,
      isMutation: tool.isMutation,
      startedAt,
      endedAt,
      ...(tool.twin ? { twin: tool.twin } : {}),
      ...(error ? { error } : {}),
    });

    const resultSummary = summarize(call);
    if (name === ESCALATE && !error) {
      const text = typeof args.reason === "string" ? args.reason : resultSummary;
      return { step: { kind: "escalation", seq: seq++, at: endedAt, text }, result };
    }
    return {
      step: {
        kind: "tool",
        seq: seq++,
        at: endedAt,
        twin: tool.twin,
        name,
        args,
        resultSummary,
        isMutation: tool.isMutation,
        ...(error ? { error } : {}),
      },
      result,
    };
  }

  return {
    async act(ctx: AgentContext): Promise<AgentStep[]> {
      const steps: AgentStep[] = [];
      let toolCalls = 0;
      const callLimit = opts.maxToolCallsPerTick ?? (spec.benchmark ? 6 : Infinity);
      // Dated as it is written, from the world's clock rather than the wall's.
      openItems.at(ctx.simTimeLabel);
      const trimNote = trimForPrompt();
      intervals.push({ at: messages.length, label: ctx.simTimeLabel });
      messages.push({
        role: "user",
        content: tickPrompt(ctx, openItems.render(), first, spec) + (trimNote ? `\n\n${trimNote}` : ""),
      });
      first = false;

      await withTick(ctx.tick, async () => {
        for (let turn = 0; turn < maxSteps; turn++) {
          let message: OpenAI.ChatCompletionMessage;
          try {
            message = await chat({
              messages,
              tools: defs,
              model: opts.model,
              effort: opts.effort,
            });
          } catch (err) {
            // The provider did not give the agent a chance to act. Stop with its
            // partial work preserved; advancing the day would manufacture missed deadlines.
            throw new AgentCallError(errorMessage(err), steps);
          }

          messages.push(message);
          const text = typeof message.content === "string" ? message.content.trim() : "";
          if (text) steps.push({ kind: "thought", seq: seq++, at: Date.now(), text });

          const calls = message.tool_calls ?? [];
          if (calls.length === 0) return;

          for (const call of calls) {
            // Only function tools exist in this loop; anything else is a provider
            // extension the harness never asked for.
            if (call.type !== "function") continue;
            if (toolCalls >= callLimit) {
              messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Tool-call budget exhausted. Continue next interval; this call was not executed." }) });
              continue;
            }
            toolCalls++;
            const args = parseArgs(call.function.arguments);
            const { step, result } = await invoke(call.function.name, args);
            steps.push(step);
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(result ?? null),
            });
          }
          if (toolCalls >= callLimit) return;
        }
        // Out of turns. Said out loud rather than silently truncated, because an
        // agent that runs the tick out every tick is a finding in itself.
        steps.push({
          kind: "thought",
          seq: seq++,
          at: Date.now(),
          text: `stopped after ${maxSteps} steps in one interval`,
        });
      });

      return steps;
    },

    async wrapUp(): Promise<string> {
      trimForPrompt();
      messages.push({
        role: "user",
        content:
          "The day is over. In a short paragraph, what did you do, what did you decide not to " +
          "do, and what is still outstanding? No tool calls.",
      });
      try {
        const message = await chat({ messages, model: opts.model, effort: opts.effort });
        const text = typeof message.content === "string" ? message.content.trim() : "";
        recordAgentSummary(text);
        return text;
      } catch (err) {
        return `the agent could not be asked for a summary: ${errorMessage(err)}`;
      }
    },
  };
}
