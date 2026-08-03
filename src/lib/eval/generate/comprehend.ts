import type { gmail_v1 } from "googleapis";
import { extractBodyText, headerMap } from "../../sync/transform";
import { completeJSON } from "../llm";
import { withRole } from "../trace";
import type { Ranked, Stage, ThreadContext } from "./types";

// Stage 3: read the winning thread the way a person would before answering it —
// all of it, oldest first — instead of the 500-char excerpt of one message the
// old generator worked from (`context.ts:235`). A probe written off an excerpt
// can contradict what the thread actually settled two messages later; this is the
// stage that makes "you never got back to me" checkable against the record.
//
// The scenario is deliberately NOT in the prompt. This stage reports what the
// thread says; stage 5 decides which angle the scenario can honestly take on it.
// Telling the model what we want to find is how you get a summary that says it.

/** Long threads mostly repeat themselves; 20 messages is plenty of signal per call. */
const MAX_MESSAGES = 20;
/** Kept from the top when eliding — the original ask is where the thread's point is. */
const HEAD_MESSAGES = 5;
const MAX_BODY = 2000;
const DAY_MS = 86_400_000;

interface ReadMessage {
  /** Position in the *full* thread, so elisions are visible to the model. */
  index: number;
  from: string;
  sent: string;
  body: string;
}

function day(at: number): string {
  return new Date(at).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * "Tue, 14 Apr 2026 (3 months ago)". Staleness is the fact the model most needs
 * and the one an ISO string hides — a thread that died in April reads completely
 * differently from one that died on Tuesday. Relative to the injected `now`, never
 * to the wall clock. This phrasing is for the model's eyes only; the phrasing the
 * composer quotes is stage 4's, off the anchor's real date.
 */
function stamp(at: number, now: number): string {
  const days = Math.round((now - at) / DAY_MS);
  const ago =
    days <= 0
      ? "today"
      : days === 1
        ? "yesterday"
        : days < 21
          ? `${days} days ago`
          : days < 60
            ? `${Math.round(days / 7)} weeks ago`
            : `${Math.round(days / 30)} months ago`;
  return `${day(at)} (${ago})`;
}

/**
 * Drop the quoted reply chain. Every message in a thread carries a copy of the one
 * before it, so without this the 2000-char budget is spent re-reading text the
 * transcript already contains in its own right.
 */
function stripQuoted(body: string): string {
  const lines = body.split(/\r?\n/);
  const cut = lines.findIndex((l) =>
    /^\s*(>|On\s.+\swrote:\s*$|-{2,}\s*(Original Message|Forwarded message))/.test(l),
  );
  if (cut < 0) return body.trim();
  const kept = lines.slice(0, cut).join("\n").trim();
  // A message that is nothing but a quote still says something by existing; keep it.
  return kept || body.trim();
}

/** Fetch the thread in full and flatten it to what the model needs to read. */
async function readThread(
  gmail: gmail_v1.Gmail,
  userId: string,
  threadId: string,
  now: number,
): Promise<{ total: number; kept: ReadMessage[] }> {
  const res = await gmail.users.threads.get({ userId, id: threadId, format: "full" });
  const msgs = res.data.messages ?? [];

  const all: ReadMessage[] = msgs.map((m, i) => {
    const h = headerMap(m.payload ?? undefined);
    const at = Number(m.internalDate ?? "0");
    return {
      index: i + 1,
      from: h.get("from") ?? "(unknown sender)",
      // internalDate is authoritative; the Date header is only a fallback for mail
      // synced without one.
      sent: at > 0 ? stamp(at, now) : (h.get("date") ?? "(no date)"),
      body: stripQuoted(extractBodyText(m.payload ?? undefined)).slice(0, MAX_BODY),
    };
  });

  if (all.length <= MAX_MESSAGES) return { total: all.length, kept: all };
  // Keep both ends: the opening ask and where it left off. The middle is the part
  // a summary can afford to lose.
  const kept = [...all.slice(0, HEAD_MESSAGES), ...all.slice(-(MAX_MESSAGES - HEAD_MESSAGES))];
  return { total: all.length, kept };
}

function renderTranscript(kept: ReadMessage[], total: number): string {
  const out: string[] = [];
  let prev = 0;
  for (const m of kept) {
    if (m.index > prev + 1) out.push(`[... ${m.index - prev - 1} messages omitted ...]`);
    out.push(`[${m.index}/${total}] From: ${m.from}\n    Sent: ${m.sent}\n\n${m.body}`);
    prev = m.index;
  }
  return out.join("\n\n");
}

const THREAD_CONTEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "leftOffAt", "owes", "openQuestions", "tone"],
  properties: {
    summary: {
      type: "string",
      description:
        "3-5 sentences on what this thread is actually about. Concrete: real names, " +
        "dates, numbers and decisions as they appear in the messages, not generalities.",
    },
    leftOffAt: {
      type: "string",
      description:
        "Where the conversation stopped: the last substantive thing said, who said it, " +
        "and whether it asked for anything back.",
    },
    owes: {
      type: "string",
      description:
        "Who owes whom what, and since when. If the thread is settled and nobody owes " +
        "anything, say exactly that.",
    },
    openQuestions: {
      type: "array",
      description:
        "Questions asked in the thread that were never answered, quoted or closely " +
        "paraphrased. Max 5. Empty array if every question was answered.",
      items: { type: "string" },
    },
    tone: {
      type: "string",
      description:
        "How these people write to each other: formality, warmth, message length, " +
        "greeting and sign-off habits, running jokes or shorthand.",
    },
  },
} as const;

/**
 * Fallback context built from the ranked candidate alone — i.e. exactly what the
 * old generator had. Degrading to the previous behaviour beats failing a run over
 * a transient model or API error, and every field says plainly what it doesn't
 * know so the composer can't quote a guess as fact.
 */
function excerptContext(ranked: Ranked, now: number): ThreadContext {
  const c = ranked.candidate;
  const unread = "Not known — the thread could not be read in full.";
  return {
    threadId: c.threadId,
    summary:
      `Thread "${c.subject}" with ${c.fromName} <${c.fromAddr}>, ${c.messageCount} message(s). ` +
      `The most recent message reads: ${c.bodyExcerpt}`,
    leftOffAt:
      `${c.fromName} wrote on ${stamp(c.internalDate, now)}; the owner ` +
      `${c.ownerReplied ? "has replied on this thread" : "never replied"}.`,
    owes: c.ownerReplied ? unread : `The owner owes ${c.fromName} a reply.`,
    openQuestions: [],
    tone: unread,
  };
}

/**
 * Comprehension stage. Takes the ranked list rather than a bare winner so the
 * pipeline can hand stages straight to each other, and so this stage owns the
 * "nothing qualified" case instead of every caller re-deciding it.
 */
export const comprehendStage: Stage<Ranked[], ThreadContext> = {
  name: "comprehend",

  async run(ranked, ctx) {
    // Ties keep rank order, so this is the winner even if the list arrives unsorted.
    const winner = ranked.reduce<Ranked | null>(
      (best, r) => (best === null || r.score > best.score ? r : best),
      null,
    );

    if (!winner) {
      // An empty threadId is the downstream signal that nothing was anchored — the
      // scenario still gets written, just without real history behind it.
      ctx.say("comprehend: no candidate thread — the probe will not be anchored");
      const none = "No thread in this mailbox qualified as an anchor.";
      return {
        threadId: "",
        summary: none,
        leftOffAt: none,
        owes: none,
        openQuestions: [],
        tone: none,
      };
    }

    const c = winner.candidate;

    return withRole("generator", async () => {
      try {
        const { total, kept } = await readThread(ctx.gmail, ctx.userId, c.threadId, ctx.now);
        ctx.say(
          `comprehend: read ${kept.length}/${total} messages of "${c.subject}" in full`,
        );

        const parsed = await completeJSON<Omit<ThreadContext, "threadId">>({
          system:
            "You read one real email thread and report what is in it. Report only what the " +
            "messages support: quote or paraphrase what was actually written, and where the " +
            "thread is silent on something, say it is silent. Never invent names, dates, " +
            "commitments or outcomes — a later step writes email that depends on this being " +
            "true, so a plausible-sounding guess is worse than an admission of ignorance.",
          prompt:
            `MAILBOX OWNER: ${ctx.profile.ownerName} <${ctx.profile.ownerEmail}>\n` +
            `TODAY IS: ${day(ctx.now)}\n` +
            `THREAD SUBJECT: ${c.subject}\n\n` +
            `FULL THREAD, ${total} message(s), oldest first:\n\n` +
            `${renderTranscript(kept, total)}\n\n` +
            `Report what this thread is about, where it left off, who owes whom what, ` +
            `which questions are still open, and how these people write to each other.`,
          schema: THREAD_CONTEXT_SCHEMA as unknown as Record<string, unknown>,
          schemaName: "thread_context",
          model: ctx.model("comprehend"),
          effort: "medium",
        });

        // `openQuestions` is joined downstream without a guard, and a provider that
        // only soft-honours the schema can omit it — default it here rather than let
        // a missing array kill the run.
        return { threadId: c.threadId, ...parsed, openQuestions: parsed.openQuestions ?? [] };
      } catch (err) {
        ctx.say(
          `comprehend: ${(err as Error).message} — falling back to the message excerpt`,
        );
        return excerptContext(winner, ctx.now);
      }
    });
  },
};
