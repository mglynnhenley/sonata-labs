import type { gmail_v1 } from "googleapis";
import { connectGmail } from "../eval/client";
import { SANDBOX_TOKEN } from "../gmail/auth";
import { headerMap } from "../sync/transform";
import { captureSnapshot } from "../eval/judge/snapshot";
import type { MailboxSnapshot } from "../eval/judge/types";

// The mailbox as the judge sees it, over HTTP. The capture itself is the eval
// judge's `captureSnapshot` unchanged — it already talks to the sandbox through
// the official SDK, so a snapshot can only see what the agent could have
// changed, and the same code produces the same artifact whether an episode or
// the old single-shot eval took it.
//
// The one addition is drafts: an episode scores autonomy, and "wrote the reply
// but would not send it" is the clearest evidence of an agent handing the job
// back — invisible in threads and labels, obvious here.

/**
 * Structurally `GmailSnapshot` from @sonata/core. Not imported: the twin has to
 * build with no orchestrator installed (see ./types).
 */
export type GmailTwinSnapshot = MailboxSnapshot & {
  twin: "gmail";
  drafts: Array<{
    draftId: string;
    threadId?: string;
    to: string[];
    subject: string;
    excerpt: string;
  }>;
};

/** A mailbox with hundreds of drafts is a bug, not a scenario; cap and move on. */
const MAX_DRAFTS = 50;

function splitAddrs(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function captureDrafts(
  gmail: gmail_v1.Gmail,
  userId: string,
): Promise<GmailTwinSnapshot["drafts"]> {
  const list = await gmail.users.drafts.list({ userId, maxResults: MAX_DRAFTS });
  const out: GmailTwinSnapshot["drafts"] = [];

  for (const d of list.data.drafts ?? []) {
    if (!d.id) continue;
    // drafts.list returns minimal messages (no headers), so the body has to come
    // from a get. `snippet` is Gmail's own preview — a digest, not the draft.
    const full = await gmail.users.drafts.get({ userId, id: d.id });
    const msg = full.data.message;
    const headers = headerMap(msg?.payload ?? undefined);
    out.push({
      draftId: d.id,
      threadId: msg?.threadId ?? undefined,
      to: splitAddrs(headers.get("to") ?? ""),
      subject: headers.get("subject") ?? "",
      excerpt: msg?.snippet ?? "",
    });
  }
  return out;
}

/**
 * @param origin the twin's own base URL, taken from the incoming request so the
 * capture works on whatever port this instance was started on.
 */
export async function captureTwinSnapshot(origin: string): Promise<GmailTwinSnapshot> {
  const gmail = connectGmail(origin, SANDBOX_TOKEN);
  const mailbox = await captureSnapshot(gmail, "me");
  const drafts = await captureDrafts(gmail, "me");
  return { twin: "gmail", ...mailbox, drafts };
}
