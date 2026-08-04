import type { gmail_v1 } from "googleapis";
import { extractBodyText, headerMap } from "../../sync/transform";
// Same machine/role-mailbox filters the profiler uses: a scenario role bound to a
// no-reply address is implausible however the thread was found.
import { AUTOMATED, ROLE_ACCOUNT } from "../context";
import type { MailboxProfile, StressScenario } from "../types";
import type { Candidate, Stage, StageCtx } from "./types";

// ---------------------------------------------------------------------------
// Stage 1 — recall. The old path skimmed 40 INBOX messages once (`context.ts:40`)
// and handed the identical pool to every scenario, so the thread that actually
// serves the premise — an unanswered complaint, a real back-and-forth with a
// named contact — was found only when it happened to sit near the top of the
// inbox. This stage asks the mailbox several targeted questions instead, unions
// the answers by thread, and hydrates each one far enough that stage 2 can rank
// on evidence rather than on recency alone. No model call: recall is a query
// problem, and a query is cheaper, faster and more auditable than a prompt.
// ---------------------------------------------------------------------------

/** Hard ceiling on what leaves this stage — every later stage pays per candidate. */
const MAX_CANDIDATES = 40;

/**
 * Threads hydrated before giving up. Larger than the cap because a machine sender
 * is only visible after the thread is fetched, so a newsletter-heavy mailbox needs
 * headroom to still yield 40 human candidates.
 */
const HYDRATE_BUDGET = 60;

/** Contacts and topics worth a query each — the profile lists them best-first. */
const MAX_CONTACT_QUERIES = 8;
const MAX_TOPIC_QUERIES = 4;

/** Bare address shape — a profile's `email` is model output and can be prose. */
const ADDRESS = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;

function parseAddr(raw: string): { name: string; email: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m && m[1].trim()) return { name: m[1].trim(), email: m[2].trim() };
  const email = (m ? m[2] : raw).trim();
  return { name: email.split("@")[0] || email, email };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Query construction — pure, so it is testable without a mailbox.
// ---------------------------------------------------------------------------

export interface RecallQuery {
  /** Why this question is being asked — surfaced by `--explain`. */
  why: string;
  /** Gmail search expression; omitted for a plain label listing. */
  q?: string;
  labelIds?: string[];
  maxResults: number;
}

/**
 * The questions this scenario needs the mailbox to answer.
 *
 * Deliberately unbounded in time: a synced archive can be months old end to end,
 * and an empty pool is a worse failure than an old anchor — stage 4 is what makes
 * the dates honest, so recall does not have to be picky about them. That is also
 * why nothing here reads `now`.
 */
export function buildRecallQueries(
  scenario: StressScenario,
  profile: MailboxProfile,
): RecallQuery[] {
  const criteria = scenario.anchorCriteria;
  const queries: RecallQuery[] = [];

  const contacts = (profile.contacts ?? [])
    .map((c) => (c.email ?? "").trim())
    .filter((email) => ADDRESS.test(email));

  // Named correspondents first: these are the threads a probe can be honestly
  // attributed to, and they are exactly what an inbox skim loses once the person
  // has been quiet for a page or two.
  for (const email of contacts.slice(0, MAX_CONTACT_QUERIES)) {
    queries.push({ why: `from:${email}`, q: `from:${email}`, maxResults: 8 });
  }

  // A thread the owner answered is reachable through the owner's own sent mail
  // even when the counterparty's last word has aged out of the inbox — which is
  // the only place `requireBackAndForth` can find its evidence.
  if (criteria?.requireBackAndForth) {
    for (const email of contacts.slice(0, MAX_TOPIC_QUERIES)) {
      queries.push({ why: `to:${email}`, q: `to:${email}`, maxResults: 8 });
    }
  }

  for (const raw of (profile.topics ?? []).slice(0, MAX_TOPIC_QUERIES)) {
    // Strip quotes before re-quoting: the topic is model output, and one stray
    // quote would re-tokenize the whole expression (`search/parse.ts:60`).
    const topic = collapse(raw.replace(/["\\]/g, " "));
    if (topic.length < 3) continue;
    queries.push({ why: `topic "${topic}"`, q: `"${topic}"`, maxResults: 6 });
  }

  const unread: RecallQuery = {
    why: "unread inbox",
    q: "is:unread",
    labelIds: ["INBOX"],
    maxResults: 15,
  };
  // No query language can express "the owner never replied" — hydration computes
  // that below. Unread is the closest available proxy, so a scenario that lives on
  // unanswered mail leads with it and gets first call on the cap.
  if (criteria?.requireUnanswered) queries.unshift(unread);
  else queries.push(unread);

  // Backstop: the old behaviour, kept last so it fills whatever the targeted
  // questions left over. A mailbox with no profile contacts still gets a pool.
  queries.push({ why: "recent inbox", labelIds: ["INBOX"], maxResults: 25 });

  return queries;
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

/**
 * The owner's real address. `getProfile` is the authority; `profile.ownerEmail` is
 * an LLM's reading of the mailbox, so it backstops rather than leads.
 */
async function ownerAddress(ctx: StageCtx): Promise<string> {
  try {
    const res = await ctx.gmail.users.getProfile({ userId: ctx.userId });
    if (res.data.emailAddress) return res.data.emailAddress.toLowerCase();
  } catch {
    // Profile endpoint unavailable — fall through to the profile's copy.
  }
  return (ctx.profile.ownerEmail ?? "").toLowerCase();
}

/**
 * Did the owner write this message? Stage 2's `requireUnanswered` is only as
 * sound as this answer, so it uses three signals: a SENT label is proof whatever
 * the From line says (aliases, plus-addressing, a domain rename all defeat a
 * string compare), a DRAFT label is proof of the opposite — composed and never
 * sent is precisely the unanswered case worth testing — and the From address
 * settles everything else.
 */
function ownerAuthored(msg: gmail_v1.Schema$Message, ownerAddr: string): boolean {
  const labels = msg.labelIds ?? [];
  if (labels.includes("DRAFT")) return false;
  if (labels.includes("SENT")) return true;
  if (!ownerAddr) return false;
  const from = headerMap(msg.payload ?? undefined).get("from") ?? "";
  return parseAddr(from).email.toLowerCase() === ownerAddr;
}

/**
 * Did the owner's own hand write this text? Same signals as `ownerAuthored` minus
 * the DRAFT exception: an unsent draft is not a *reply*, but it is still the
 * owner's prose, so it can never be quoted back as a counterparty's words.
 */
function ownerWrote(msg: gmail_v1.Schema$Message, ownerAddr: string): boolean {
  const labels = msg.labelIds ?? [];
  if (labels.includes("DRAFT") || labels.includes("SENT")) return true;
  if (!ownerAddr) return false;
  const from = headerMap(msg.payload ?? undefined).get("from") ?? "";
  return parseAddr(from).email.toLowerCase() === ownerAddr;
}

/** First non-empty Subject, newest message first — a reply's is usually "Re: …". */
function threadSubject(messages: gmail_v1.Schema$Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const subject = headerMap(messages[i].payload ?? undefined).get("subject");
    if (subject) return subject;
  }
  return "";
}

async function hydrate(
  ctx: StageCtx,
  threadId: string,
  ownerAddr: string,
): Promise<Candidate | null> {
  let messages: gmail_v1.Schema$Message[];
  try {
    // format=full in one request rather than metadata plus a second get for the
    // body: the excerpt is what stage 2 ranks and stage 5 reasons over, so it is
    // never the part worth saving bytes on.
    const res = await ctx.gmail.users.threads.get({
      userId: ctx.userId,
      id: threadId,
      format: "full",
    });
    messages = res.data.messages ?? [];
  } catch {
    // The thread went away between list and get, or the store rejected it. One
    // unreadable thread is not a reason to lose the other thirty-nine.
    return null;
  }
  if (messages.length === 0) return null;

  // Sort rather than trust array order: ordering is an API convention, not a
  // guarantee, and "the last message" decides both threading and the timeline.
  const sorted = [...messages].sort(
    (a, b) => Number(a.internalDate ?? "0") - Number(b.internalDate ?? "0"),
  );
  const last = sorted[sorted.length - 1];
  if (!last.id) return null;

  // Every message, not just the newest: an escalation premise is false the moment
  // the owner answered anywhere in the thread, and the answer is rarely last.
  const ownerReplied = sorted.some((m) => ownerAuthored(m, ownerAddr));

  // From and excerpt come from the newest message the owner did NOT write. On a
  // thread the owner replied to last, reading the From line off the final message
  // would bind the owner as their own counterparty — and the excerpt has to be
  // that same person's words, since the generator quotes the two together
  // ("Last message from <fromName>: <bodyExcerpt>", `generate.ts:140`).
  // A thread the owner wrote every message of (sent mail, an unsent draft) has no
  // correspondent to bind, so it is not a usable anchor at all — falling back to
  // the newest message would make the owner their own counterparty.
  const counterparty = [...sorted].reverse().find((m) => !ownerWrote(m, ownerAddr));
  if (!counterparty) return null;
  const fromHeader = headerMap(counterparty.payload ?? undefined).get("from") ?? "";
  const { name, email } = parseAddr(fromHeader);
  if (!email || AUTOMATED.test(fromHeader) || ROLE_ACCOUNT.test(email)) return null;

  return {
    threadId,
    lastMessageId: last.id,
    subject: threadSubject(sorted),
    fromName: name,
    fromAddr: email,
    // The thread's real last activity — stage 4 rebases every slot off this, so it
    // must be the newest message even when the owner wrote it.
    internalDate: Number(last.internalDate ?? "0"),
    messageCount: sorted.length,
    ownerReplied,
    bodyExcerpt: collapse(extractBodyText(counterparty.payload ?? undefined)).slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

export const recallStage: Stage<void, Candidate[]> = {
  name: "recall",

  async run(_input, ctx) {
    const ownerAddr = await ownerAddress(ctx);
    const queries = buildRecallQueries(ctx.scenario, ctx.profile);

    const hits: string[][] = [];
    for (const query of queries) {
      try {
        const res = await ctx.gmail.users.messages.list({
          userId: ctx.userId,
          q: query.q,
          labelIds: query.labelIds,
          maxResults: query.maxResults,
        });
        // List items carry {id, threadId} only, so the union can be built on thread
        // ids without fetching a single message first.
        const ids = (res.data.messages ?? [])
          .map((m) => m.threadId)
          .filter((id): id is string => !!id);
        hits.push(ids);
        ctx.say(`recall ${query.why}: ${ids.length} hit(s)`);
      } catch {
        // A mailbox synced without SENT, or with a label the store never created,
        // makes individual queries fail. Skip the question, keep the pool.
        ctx.say(`recall ${query.why}: skipped (query failed)`);
      }
    }

    // Round-robin across queries rather than concatenating them: a straight concat
    // would let twenty-five recent-inbox hits exhaust the budget before a single
    // from:<contact> thread was ever looked at, which is the exact blindness this
    // stage exists to fix.
    const pool: string[] = [];
    const seen = new Set<string>();
    for (let depth = 0; pool.length < HYDRATE_BUDGET; depth++) {
      let advanced = false;
      for (const ids of hits) {
        const threadId = ids[depth];
        if (threadId === undefined) continue;
        advanced = true;
        if (seen.has(threadId)) continue;
        seen.add(threadId);
        pool.push(threadId);
        if (pool.length >= HYDRATE_BUDGET) break;
      }
      if (!advanced) break;
    }

    const candidates: Candidate[] = [];
    for (const threadId of pool) {
      if (candidates.length >= MAX_CANDIDATES) break;
      const candidate = await hydrate(ctx, threadId, ownerAddr);
      if (candidate) candidates.push(candidate);
    }

    if (candidates.length === 0) {
      // Declared fallback: nothing. Returning the machine senders instead would
      // hand stage 2 a newsletter to anchor an escalation on, which is worse than
      // the unanchored path the pipeline already handles.
      ctx.say(`recall: no human-sender thread in ${pool.length} thread(s) — no candidates`);
    } else {
      ctx.say(
        `recall: ${candidates.length} candidate(s) from ${queries.length} queries, ` +
          `${candidates.filter((c) => !c.ownerReplied).length} unanswered`,
      );
    }
    return candidates;
  },
};
