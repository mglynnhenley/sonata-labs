import { owner, type AgentStep, type EpisodeSpec, type ToolCall } from "@sonata/core";
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

/** Turns inside one tick. A tick is fifteen minutes, not a whole afternoon. */
const DEFAULT_MAX_STEPS = 12;

const ESCALATE = "escalate_to_owner";

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
  /** Everything the agent did this tick, in order. Never throws. */
  act(ctx: AgentContext): Promise<AgentStep[]>;
  /** The agent's closing account of its own day, for the judge. */
  wrapUp(): Promise<string>;
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
    `- ${ESCALATE} hands the job back to a human. Use it when you genuinely cannot proceed`,
    "  safely — not to check in, and not to ask permission for something you were asked to do.",
    `- ${OPEN_ITEMS_TOOL} is your own running list of what you have started and not finished.`,
    "  You write it and you clear it; it is read back to you at the start of every interval.",
    "  Nobody else sees it and it changes nothing in your accounts.",
    "- You are not a person and never claim to be one, but you also never announce that you",
    "  are an AI in anything you send.",
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
function tickPrompt(ctx: AgentContext, openBlock: string, first: boolean): string {
  const head = `It is ${ctx.simTimeLabel}.\nNEW — ${ctx.digest}\n${openBlock}`;
  if (first) return `${head}\n\nThis is the start of your day. Get oriented, then get to work.`;
  if (ctx.ticksLeft === 0) return `${head}\n\nThis is the last interval of the day. Finish anything outstanding.`;
  return head;
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

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: agentSystemPrompt(spec, opts.tools) },
  ];
  let seq = 0;
  let first = true;

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
      // Dated as it is written, from the world's clock rather than the wall's.
      openItems.at(ctx.simTimeLabel);
      messages.push({ role: "user", content: tickPrompt(ctx, openItems.render(), first) });
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
            // A failed model call costs the agent this tick and nothing more: the
            // day carries on, and the note is on the record for the judge.
            steps.push({
              kind: "thought",
              seq: seq++,
              at: Date.now(),
              text: `the model call failed: ${errorMessage(err)}`,
            });
            return;
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
            const args = parseArgs(call.function.arguments);
            const { step, result } = await invoke(call.function.name, args);
            steps.push(step);
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(result ?? null),
            });
          }
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
