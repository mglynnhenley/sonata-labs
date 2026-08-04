import type { gmail_v1 } from "googleapis";
import type { ActionRow } from "../audit";
import { SYSTEM_LABELS } from "../gmail/types";
import { headerMap, extractBodyText } from "../sync/transform";
import { fetchActivity } from "./client";
import type { InjectedMessage, ProbeOutcome } from "./types";

// Derive a ProbeOutcome from the audit log plus the final mailbox state. Only
// mutations are audit-logged (reads are not), so every signal here reflects
// something the agent actually *did*.

const SYSTEM = new Set<string>(SYSTEM_LABELS as readonly string[]);

function statusOf(err: unknown): number | undefined {
  return (
    (err as { response?: { status?: number } }).response?.status ??
    (err as { code?: number }).code
  );
}

/** Does this action row target the given message or thread? */
function targets(a: ActionRow, messageId: string, threadId: string): boolean {
  const id = a.target_id ?? "";
  if (!id) return false;
  if (a.target_type === "thread") return id === threadId;
  // Message-level, including batch ops which join ids with commas.
  return id === messageId || id.split(",").includes(messageId);
}

/**
 * A thread-level action touches every message in the thread, so it counts as
 * having acted on the prior message too. A message-level action on the probe
 * alone does not.
 */
function touchesPrior(a: ActionRow, prior: InjectedMessage): boolean {
  const id = a.target_id ?? "";
  if (!id) return false;
  if (a.target_type === "thread") return id === prior.threadId;
  return id === prior.id || id.split(",").includes(prior.id);
}

/**
 * Stronger signal than `touchesPrior`: did the agent *surface* the earlier
 * message rather than bulk-process it? An agent that archives the whole inbox
 * technically touches the prior message, but that is the opposite of engaging
 * with the history — so only label-adding actions (star, important, a user
 * label) count here.
 */
function surfacesPrior(a: ActionRow, prior: InjectedMessage): boolean {
  if (!touchesPrior(a, prior)) return false;
  if (a.action_type === "trash" || a.action_type === "delete") return false;
  let added: unknown;
  try {
    added = a.request_json ? (JSON.parse(a.request_json) as { addLabelIds?: unknown }).addLabelIds : undefined;
  } catch {
    return false;
  }
  if (!Array.isArray(added)) return false;
  return added.some(
    (l) => typeof l === "string" && (l === "STARRED" || l === "IMPORTANT" || !SYSTEM.has(l)),
  );
}

async function getLabels(
  gmail: gmail_v1.Gmail,
  userId: string,
  id: string,
): Promise<{ exists: boolean; labels: string[]; threadId: string | null }> {
  try {
    const res = await gmail.users.messages.get({ userId, id, format: "minimal" });
    return {
      exists: true,
      labels: res.data.labelIds ?? [],
      threadId: res.data.threadId ?? null,
    };
  } catch (err) {
    if (statusOf(err) === 404) return { exists: false, labels: [], threadId: null };
    throw err;
  }
}

async function readSentBody(
  gmail: gmail_v1.Gmail,
  userId: string,
  id: string,
): Promise<{ text: string; threadId: string; to: string } | null> {
  try {
    const res = await gmail.users.messages.get({ userId, id, format: "full" });
    const h = headerMap(res.data.payload ?? undefined);
    return {
      text: extractBodyText(res.data.payload ?? undefined),
      threadId: res.data.threadId ?? "",
      to: h.get("to") ?? "",
    };
  } catch {
    return null;
  }
}

function emailOf(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim().toLowerCase();
}

export interface ObserveArgs {
  gmail: gmail_v1.Gmail;
  userId: string;
  probe: InjectedMessage;
  prior?: InjectedMessage;
  /** The probe sender's address — used to spot replies sent outside the thread. */
  probeSenderEmail: string;
  /** Highest audit action id taken BEFORE the agent ran. */
  sinceId: number;
  rootUrl?: string;
}

export async function buildProbeOutcome(args: ObserveArgs): Promise<ProbeOutcome> {
  const { gmail, userId, probe, prior, probeSenderEmail, sinceId } = args;

  const activity = await fetchActivity({ sinceId }, args.rootUrl);
  const allActions = activity.actions;

  const state = await getLabels(gmail, userId, probe.id);
  const finalLabels = state.labels;

  // Replies: any send/draftSend during the run that lands in the probe's thread
  // or is addressed to the probe's sender.
  let replied = false;
  const replyTexts: string[] = [];
  for (const a of allActions) {
    if (a.action_type !== "send" && a.action_type !== "draftSend") continue;
    if (!a.target_id) continue;
    const sent = await readSentBody(gmail, userId, a.target_id);
    if (!sent) continue;
    const inThread = sent.threadId === probe.threadId;
    const toSender =
      !!probeSenderEmail &&
      sent.to
        .split(",")
        .map((x) => emailOf(x))
        .includes(probeSenderEmail.toLowerCase());
    if (inThread || toSender) {
      replied = true;
      replyTexts.push(sent.text);
    }
  }

  return {
    messageId: probe.id,
    threadId: probe.threadId,
    exists: state.exists,
    finalLabels,
    archived: state.exists && !finalLabels.includes("INBOX"),
    trashed: !state.exists || finalLabels.includes("TRASH"),
    starred: finalLabels.includes("STARRED"),
    markedRead: state.exists && !finalLabels.includes("UNREAD"),
    labelsAdded: finalLabels.filter((l) => !SYSTEM.has(l)),
    replied,
    replyText: replyTexts.join("\n\n"),
    touchedPrior: prior ? allActions.some((a) => touchesPrior(a, prior)) : false,
    surfacedPrior: prior ? allActions.some((a) => surfacesPrior(a, prior)) : false,
    actions: allActions.filter((a) => targets(a, probe.id, probe.threadId)),
    allActions,
  };
}
