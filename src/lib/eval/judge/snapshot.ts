import type { gmail_v1 } from "googleapis";
import { headerMap } from "../../sync/transform";
import type { MailboxDiff, MailboxSnapshot } from "./types";

// Snapshot the mailbox through the official SDK — the same surface the agent
// under test uses, so the snapshot can only see what the agent could have
// changed. Taken twice per run (before and after triage) and diffed, which is
// what turns "the agent called messages.modify" into "this thread left the
// inbox". Capture talks to the sandbox; `diffSnapshots` is pure, so old
// artifacts can be re-diffed offline.

/**
 * Threads per snapshot. Two snapshots ship inside every run artifact and live
 * there forever, so this is capped rather than drained. Threads come back
 * newest-first, so the cap sheds the oldest — the ones a triage agent is least
 * likely to have touched.
 */
const MAX_THREADS = 200;

/** Gmail's own page size; the cap is reached in two requests. */
const PAGE = 100;

/** Pull the label roster with live unread counts. */
async function captureLabels(
  gmail: gmail_v1.Gmail,
  userId: string,
): Promise<MailboxSnapshot["labels"]> {
  const list = await gmail.users.labels.list({ userId });
  const out: MailboxSnapshot["labels"] = [];

  for (const l of list.data.labels ?? []) {
    if (!l.id) continue;
    // labels.list omits counts by Gmail's contract, not by sandbox shortfall, so
    // the unread number has to come from labels.get. An INBOX unread count that
    // falls from 12 to 0 is the clearest signal a sweep happened.
    const full = await gmail.users.labels.get({ userId, id: l.id });
    out.push({
      id: l.id,
      name: full.data.name ?? l.name ?? l.id,
      unread: full.data.messagesUnread ?? 0,
    });
  }
  return out;
}

async function listThreadIds(gmail: gmail_v1.Gmail, userId: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  while (ids.length < MAX_THREADS) {
    const res = await gmail.users.threads.list({
      userId,
      // TRASH and SPAM included deliberately: a trashed thread is the only trace
      // a destructive action leaves, and hiding it would render as a thread that
      // simply vanished.
      includeSpamTrash: true,
      maxResults: Math.min(PAGE, MAX_THREADS - ids.length),
      pageToken,
    });
    for (const t of res.data.threads ?? []) {
      if (t.id) ids.push(t.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return ids;
}

/**
 * The Date header is what the agent reads, so that is what the snapshot records
 * — but it is sender-supplied and can be absent or malformed, and internalDate
 * is the server's own stamp, so it backstops.
 */
function messageDate(headers: Map<string, string>, msg: gmail_v1.Schema$Message): number {
  const parsed = Date.parse(headers.get("date") ?? "");
  return Number.isFinite(parsed) ? parsed : Number(msg.internalDate ?? "0");
}

async function captureThread(
  gmail: gmail_v1.Gmail,
  userId: string,
  threadId: string,
): Promise<MailboxSnapshot["threads"][number] | null> {
  // metadata, not full: headers and labels are everything the diff needs, and
  // bodies would multiply the artifact by an order of magnitude.
  const res = await gmail.users.threads.get({ userId, id: threadId, format: "metadata" });
  const messages = res.data.messages ?? [];
  if (messages.length === 0) return null;

  // Latest by internalDate rather than array position: ordering is an API
  // convention, not a guarantee, and the newest message is the one whose sender
  // and subject describe the thread as it stands.
  const latest = messages.reduce((a, b) =>
    Number(b.internalDate ?? "0") >= Number(a.internalDate ?? "0") ? b : a,
  );
  const headers = headerMap(latest.payload ?? undefined);

  // Union across messages, because Gmail applies labels per message: a thread is
  // out of the inbox only when none of its messages carries INBOX.
  const labels = new Set<string>();
  for (const m of messages) {
    for (const l of m.labelIds ?? []) labels.add(l);
  }

  return {
    threadId,
    subject: headers.get("subject") ?? "",
    from: headers.get("from") ?? "",
    date: messageDate(headers, latest),
    labels: [...labels].sort(),
    unread: messages.some((m) => (m.labelIds ?? []).includes("UNREAD")),
    starred: messages.some((m) => (m.labelIds ?? []).includes("STARRED")),
    count: messages.length,
  };
}

export async function captureSnapshot(
  gmail: gmail_v1.Gmail,
  userId: string,
): Promise<MailboxSnapshot> {
  const labels = await captureLabels(gmail, userId);
  const ids = await listThreadIds(gmail, userId);

  const threads: MailboxSnapshot["threads"] = [];
  for (const id of ids) {
    const thread = await captureThread(gmail, userId, id);
    if (thread) threads.push(thread);
  }

  return { capturedAt: Date.now(), labels, threads };
}

// ---------------------------------------------------------------------------
// Diff — pure, no I/O. Keyed by threadId, which survives every mutation an
// agent can make; subjects and labels do not.
// ---------------------------------------------------------------------------

function difference(a: string[], b: string[]): string[] {
  const other = new Set(b);
  return a.filter((x) => !other.has(x)).sort();
}

/**
 * Stable ordering for snapshot tests. Subject first because it is what a reader
 * scans; threadId breaks ties, since two threads can share a subject and the
 * capture order must not leak into the output.
 */
function bySubject(
  a: { subject: string; threadId: string },
  b: { subject: string; threadId: string },
): number {
  if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
  if (a.threadId === b.threadId) return 0;
  return a.threadId < b.threadId ? -1 : 1;
}

export function diffSnapshots(before: MailboxSnapshot, after: MailboxSnapshot): MailboxDiff {
  const beforeById = new Map(before.threads.map((t) => [t.threadId, t]));
  const afterIds = new Set(after.threads.map((t) => t.threadId));

  const added: MailboxDiff["added"] = [];
  const removed: MailboxDiff["removed"] = [];
  const changed: MailboxDiff["changed"] = [];
  let unchangedCount = 0;

  for (const t of after.threads) {
    const prev = beforeById.get(t.threadId);
    if (!prev) {
      added.push({ threadId: t.threadId, subject: t.subject, from: t.from });
      continue;
    }

    const labelsAdded = difference(t.labels, prev.labels);
    const labelsRemoved = difference(prev.labels, t.labels);
    const unreadChanged = t.unread !== prev.unread;
    const starredChanged = t.starred !== prev.starred;
    const messagesAdded = t.count - prev.count;

    if (
      labelsAdded.length === 0 &&
      labelsRemoved.length === 0 &&
      !unreadChanged &&
      !starredChanged &&
      messagesAdded === 0
    ) {
      // Counted, never listed. A triaged mailbox is overwhelmingly untouched, and
      // spelling out two hundred unchanged threads would fill the judge's prompt
      // with precisely the rows carrying no signal. The count still answers the
      // question that matters: how much did it leave alone?
      unchangedCount++;
      continue;
    }

    const entry: MailboxDiff["changed"][number] = {
      threadId: t.threadId,
      subject: t.subject,
      labelsAdded,
      labelsRemoved,
      messagesAdded,
    };
    // Set only when true — these mirror UNREAD/STARRED moving in the label set,
    // and they exist so the judge reads the state change at a glance rather than
    // scanning arrays. A `false` would cost tokens to say nothing.
    if (unreadChanged) entry.unreadChanged = true;
    if (starredChanged) entry.starredChanged = true;
    changed.push(entry);
  }

  // Gone entirely — permanently deleted, since trashing leaves the thread visible
  // with a TRASH label and therefore shows up as a change, not a removal.
  // Each snapshot is independently capped at the newest MAX_THREADS, so when
  // `after` is full a new thread pushes the oldest one out of the window. That
  // eviction is not a deletion: anything older than everything `after` retained
  // is unknowable from here, so it is left out rather than reported as gone.
  const afterFloor =
    after.threads.length >= MAX_THREADS
      ? Math.min(...after.threads.map((t) => t.date))
      : -Infinity;
  for (const t of before.threads) {
    if (!afterIds.has(t.threadId) && t.date >= afterFloor) {
      removed.push({ threadId: t.threadId, subject: t.subject });
    }
  }

  return {
    added: added.sort(bySubject),
    removed: removed.sort(bySubject),
    changed: changed.sort(bySubject),
    unchangedCount,
  };
}
