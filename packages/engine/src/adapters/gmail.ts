import {
  displayAddress,
  type BeatBody,
  type EpisodeSpec,
  type GmailDiff,
  type GmailSnapshot,
  type InjectContext,
  type InjectedRef,
  type JudgeStep,
  type AgentTrace,
  type TwinAdapter,
  type TwinAuditRow,
  type TwinDiff,
  type TwinHealth,
  type TwinSnapshot,
} from "@sonata/core";
import { createTwinHttp, type TwinHttpOptions } from "../http";
import { extractBodyText, headerMap, type GmailMessage } from "../gmailMime";
import { projectTwinTrace } from "../project";
import {
  auditViaActivity,
  byKey,
  clip,
  difference,
  healthViaApi,
  resetViaApi,
  seedViaApi,
} from "./shared";

// The Gmail twin, behind @sonata/core's TwinAdapter.
//
// Capture goes through the same public Gmail-v1 surface the agent uses, so a
// snapshot can only ever see what the agent could have changed — that is what
// turns "it called messages.modify" into "this thread left the inbox". `diff` and
// `renderDiff` are pure, so a finished run can be re-diffed and re-judged months
// later with nothing running.
//
// The diff logic here is apps/gmail's src/lib/eval/judge/snapshot.ts, moved onto
// the shared snapshot types and extended with drafts — the tell for "wrote it but
// would not send it", which is an autonomy signal and so cannot be left out.

/**
 * Threads per snapshot. Two snapshots ship inside every run artifact and live
 * there forever, so this is capped rather than drained. Threads come back
 * newest-first, so the cap sheds the oldest — the ones an agent working today is
 * least likely to have touched.
 */
const MAX_THREADS = 200;

/** Gmail's own page size; the cap is reached in two requests. */
const PAGE = 100;

const MAX_EXCERPT = 200;

interface LabelResource {
  id?: string;
  name?: string;
  messagesUnread?: number;
}

export interface GmailAdapterOptions extends Omit<TwinHttpOptions, "baseUrl"> {
  /** Defaults to the port the monorepo's `dev:gmail` script uses. */
  baseUrl?: string;
  userId?: string;
}

export function createGmailAdapter(opts: GmailAdapterOptions = {}): TwinAdapter {
  const baseUrl = opts.baseUrl ?? process.env.GMAIL_TWIN_URL ?? "http://localhost:3101";
  const http = createTwinHttp("gmail", { ...opts, baseUrl });
  const userId = opts.userId ?? "me";
  const api = `/gmail/v1/users/${encodeURIComponent(userId)}`;

  async function captureLabels(): Promise<GmailSnapshot["labels"]> {
    const list = await http.get<{ labels?: LabelResource[] }>(`${api}/labels`);
    const out: GmailSnapshot["labels"] = [];
    for (const l of list.labels ?? []) {
      if (!l.id) continue;
      // labels.list omits counts by Gmail's contract, so the unread number has to
      // come from labels.get. An INBOX unread count falling from 12 to 0 is the
      // clearest signal a sweep happened.
      const full = await http.get<LabelResource>(`${api}/labels/${encodeURIComponent(l.id)}`);
      out.push({ id: l.id, name: full.name ?? l.name ?? l.id, unread: full.messagesUnread ?? 0 });
    }
    return out;
  }

  async function listThreadIds(): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    while (ids.length < MAX_THREADS) {
      const res = await http.get<{ threads?: Array<{ id?: string }>; nextPageToken?: string }>(
        `${api}/threads`,
        {
          // TRASH and SPAM included deliberately: a trashed thread is the only
          // trace a destructive action leaves, and hiding it would render as a
          // thread that simply vanished.
          includeSpamTrash: true,
          maxResults: Math.min(PAGE, MAX_THREADS - ids.length),
          pageToken,
        },
      );
      for (const t of res.threads ?? []) if (t.id) ids.push(t.id);
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return ids;
  }

  /**
   * The Date header is what the agent reads, so that is what the snapshot
   * records — but it is sender-supplied and can be absent or malformed, and
   * internalDate is the server's own stamp, so it backstops.
   */
  function messageDate(headers: Map<string, string>, msg: GmailMessage): number {
    const parsed = Date.parse(headers.get("date") ?? "");
    return Number.isFinite(parsed) ? parsed : Number(msg.internalDate ?? "0");
  }

  async function captureThread(threadId: string): Promise<GmailSnapshot["threads"][number] | null> {
    // metadata, not full: headers and labels are everything the diff needs, and
    // bodies would multiply the artifact by an order of magnitude.
    const res = await http.get<{ messages?: GmailMessage[] }>(
      `${api}/threads/${encodeURIComponent(threadId)}`,
      { format: "metadata" },
    );
    const messages = res.messages ?? [];
    if (messages.length === 0) return null;

    // Latest by internalDate rather than array position: ordering is an API
    // convention, not a guarantee, and the newest message is the one whose sender
    // and subject describe the thread as it stands.
    const latest = messages.reduce((a, b) =>
      Number(b.internalDate ?? "0") >= Number(a.internalDate ?? "0") ? b : a,
    );
    const headers = headerMap(latest.payload);

    // Union across messages, because Gmail applies labels per message: a thread
    // is out of the inbox only when none of its messages carries INBOX.
    const labels = new Set<string>();
    for (const m of messages) for (const l of m.labelIds ?? []) labels.add(l);

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

  async function captureDrafts(): Promise<GmailSnapshot["drafts"]> {
    const list = await http.get<{ drafts?: Array<{ id?: string }> }>(`${api}/drafts`, {
      maxResults: PAGE,
    });
    const out: GmailSnapshot["drafts"] = [];
    for (const d of list.drafts ?? []) {
      if (!d.id) continue;
      const full = await http.get<{ id?: string; message?: GmailMessage }>(
        `${api}/drafts/${encodeURIComponent(d.id)}`,
      );
      const h = headerMap(full.message?.payload);
      out.push({
        draftId: d.id,
        ...(full.message?.threadId ? { threadId: full.message.threadId } : {}),
        to: (h.get("to") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        subject: h.get("subject") ?? "",
        excerpt: clip(extractBodyText(full.message?.payload), MAX_EXCERPT),
      });
    }
    return out;
  }

  return {
    name: "gmail",
    baseUrl,

    health(): Promise<TwinHealth> {
      return healthViaApi(http, "gmail");
    },

    async snapshot(): Promise<TwinSnapshot> {
      const labels = await captureLabels();
      const ids = await listThreadIds();
      const threads: GmailSnapshot["threads"] = [];
      for (const id of ids) {
        const thread = await captureThread(id);
        if (thread) threads.push(thread);
      }
      return {
        twin: "gmail",
        capturedAt: Date.now(),
        labels,
        threads,
        drafts: await captureDrafts(),
      };
    },

    diff(before: TwinSnapshot, after: TwinSnapshot): TwinDiff {
      return diffGmail(before as GmailSnapshot, after as GmailSnapshot);
    },

    renderDiff(diff: TwinDiff): string {
      return renderGmailDiff(diff as GmailDiff);
    },

    async inject(body: BeatBody, ctx: InjectContext): Promise<InjectedRef> {
      if (body.twin !== "gmail") throw new Error(`gmail adapter cannot inject a ${body.twin} beat`);
      const p = body.payload;
      const parent = p.inReplyTo ? ctx.resolve(p.inReplyTo) : undefined;

      // `atISO` goes on the wire as itself. The twin dates the message from it,
      // so simulated time never has to be expressed as an offset from the wall
      // clock — the older `/api/eval/inject` route took `minutesAgo`, which meant
      // every beat's timestamp depended on when the HTTP call happened to land.
      const res = await http.post<{
        injected?: { id?: string; containerId?: string };
        error?: string;
      }>("/api/sandbox/inject", {
        kind: "email",
        from: displayAddress(ctx.world, p.from),
        to: p.to.map((r) => displayAddress(ctx.world, r)),
        ...(p.cc?.length ? { cc: p.cc.map((r) => displayAddress(ctx.world, r)) } : {}),
        subject: p.subject,
        body: p.body,
        atISO: ctx.atISO,
        ...(p.labels?.length ? { labels: p.labels } : {}),
        // An unresolvable ref is left off entirely: the twin posts standalone,
        // which is a far smaller wound to the day than a failed injection.
        ...(parent ? { threadRef: parent.id } : {}),
      });
      const injected = res.injected;
      if (!injected?.id) throw new Error(res.error ?? "gmail inject returned nothing");
      return {
        twin: "gmail",
        id: injected.id,
        ...(injected.containerId ? { containerId: injected.containerId } : {}),
      };
    },

    seed(spec: EpisodeSpec): Promise<void> {
      return seedViaApi(http, "gmail", spec);
    },

    reset(): Promise<void> {
      return resetViaApi(http, "episode reset");
    },

    auditSince(sinceId: number): Promise<TwinAuditRow[]> {
      return auditViaActivity(http, "gmail", sinceId, { sinceId, limit: 1000 });
    },

    projectTrace(trace: AgentTrace): JudgeStep[] {
      return projectTwinTrace(trace, "gmail");
    },
  };
}

// ---------------------------------------------------------------------------
// Diff — pure, no I/O. Keyed by threadId, which survives every mutation an agent
// can make; subjects and labels do not.
// ---------------------------------------------------------------------------

const bySubject = byKey<{ subject: string; threadId: string }>((t) => `${t.subject}\0${t.threadId}`);

export function diffGmail(before: GmailSnapshot, after: GmailSnapshot): GmailDiff {
  const beforeById = new Map(before.threads.map((t) => [t.threadId, t]));
  const afterIds = new Set(after.threads.map((t) => t.threadId));

  const added: GmailDiff["added"] = [];
  const removed: GmailDiff["removed"] = [];
  const changed: GmailDiff["changed"] = [];
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
      // Counted, never listed. A worked mailbox is overwhelmingly untouched, and
      // spelling out two hundred unchanged threads would fill the judge's prompt
      // with precisely the rows carrying no signal. The count still answers the
      // question that matters: how much did it leave alone?
      unchangedCount++;
      continue;
    }

    const entry: GmailDiff["changed"][number] = {
      threadId: t.threadId,
      subject: t.subject,
      labelsAdded,
      labelsRemoved,
      messagesAdded,
    };
    // Set only when true — these mirror UNREAD/STARRED moving in the label set,
    // and exist so the judge reads the state change at a glance. A `false` would
    // cost tokens to say nothing.
    if (unreadChanged) entry.unreadChanged = true;
    if (starredChanged) entry.starredChanged = true;
    changed.push(entry);
  }

  // Gone entirely — permanently deleted, since trashing leaves the thread visible
  // with a TRASH label and so shows up as a change, not a removal. Each snapshot
  // is independently capped at the newest MAX_THREADS, so when `after` is full a
  // new thread pushes the oldest out of the window. That eviction is not a
  // deletion: anything older than everything `after` retained is unknowable from
  // here, so it is left out rather than reported as gone.
  const afterFloor =
    after.threads.length >= MAX_THREADS ? Math.min(...after.threads.map((t) => t.date)) : -Infinity;
  for (const t of before.threads) {
    if (!afterIds.has(t.threadId) && t.date >= afterFloor) {
      removed.push({ threadId: t.threadId, subject: t.subject });
    }
  }

  const beforeDrafts = new Set(before.drafts.map((d) => d.draftId));
  const draftsAdded = after.drafts
    .filter((d) => !beforeDrafts.has(d.draftId))
    .map((d) => ({ draftId: d.draftId, subject: d.subject, to: d.to, excerpt: d.excerpt }));

  return {
    twin: "gmail",
    added: added.sort(bySubject),
    removed: removed.sort(bySubject),
    changed: changed.sort(bySubject),
    draftsAdded,
    unchangedCount,
  };
}

export function renderGmailDiff(diff: GmailDiff): string {
  const lines: string[] = [];
  for (const t of diff.added) lines.push(`+ new thread "${t.subject}" from ${t.from}`);
  for (const t of diff.changed) {
    const bits: string[] = [];
    if (t.labelsAdded.length) bits.push(`+labels ${t.labelsAdded.join(",")}`);
    if (t.labelsRemoved.length) bits.push(`-labels ${t.labelsRemoved.join(",")}`);
    if (t.messagesAdded) bits.push(`${t.messagesAdded} new message(s)`);
    if (t.unreadChanged) bits.push("read state changed");
    if (t.starredChanged) bits.push("star changed");
    lines.push(`~ "${t.subject}": ${bits.join("; ")}`);
  }
  for (const t of diff.removed) lines.push(`- deleted "${t.subject}"`);
  for (const d of diff.draftsAdded) {
    lines.push(`= draft (unsent) to ${d.to.join(", ")} "${d.subject}": ${d.excerpt}`);
  }
  lines.push(`${diff.unchangedCount} thread(s) untouched`);
  return lines.join("\n");
}
