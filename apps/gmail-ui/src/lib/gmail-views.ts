import { apiGet } from "./api-client";
import type {
  LabelChip,
  ListView,
  RailLabel,
  ThreadMessageView,
  ThreadRow,
  ThreadView,
} from "./view-types";

// The BFF. Reproduces the API app's old DB-backed view models by composing calls
// to the PUBLIC /gmail/v1 surface — the same surface any agent uses. There is no
// database here. The N+1 fan-out (one threads.get per row) is exactly what a real
// Gmail client pays; against localhost it is cheap. If a view ever cannot be
// expressed over the API, the fix is a scoped addition to the API, never a DB
// backdoor.

const USER = "/gmail/v1/users/me";

// --- API response shapes (only the fields we read) ---------------------------

interface GHeader {
  name?: string;
  value?: string;
}
interface GPayload {
  mimeType?: string;
  filename?: string;
  headers?: GHeader[];
  body?: { data?: string };
  parts?: GPayload[];
}
interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GPayload;
}
interface GThread {
  id: string;
  messages?: GMessage[];
}
interface GLabel {
  id: string;
  name: string;
  type?: string;
  color?: { textColor?: string; backgroundColor?: string };
  messagesUnread?: number;
}

// --- helpers -----------------------------------------------------------------

function header(payload: GPayload | undefined, name: string): string {
  const h = payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function displayName(addr: string | null): string {
  if (!addr) return "(unknown)";
  const m = addr.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m && m[1].trim()) return m[1].trim();
  const email = (m ? m[2] : addr).trim();
  return email.split("@")[0] || email;
}

function initial(name: string): string {
  return (name.trim()[0] || "?").toUpperCase();
}

function hasAttachment(payload: GPayload | undefined): boolean {
  if (!payload) return false;
  if (payload.filename) return true;
  return (payload.parts ?? []).some(hasAttachment);
}

function extractBodies(payload: GPayload | undefined): { html: string | null; text: string | null } {
  let html: string | null = null;
  let text: string | null = null;
  const walk = (p: GPayload) => {
    if (p.body?.data) {
      const decoded = Buffer.from(p.body.data, "base64url").toString("utf8");
      if (p.mimeType === "text/html" && html == null) html = decoded;
      else if (p.mimeType === "text/plain" && text == null) text = decoded;
    }
    for (const c of p.parts ?? []) walk(c);
  };
  if (payload) walk(payload);
  return { html, text };
}

/** base64url(JSON{offset}) — the API's opaque pageToken format (co-designed). */
function pageToken(offset: number): string | undefined {
  return offset > 0 ? Buffer.from(JSON.stringify({ offset })).toString("base64url") : undefined;
}

type LabelMap = Map<string, GLabel>;

async function fetchLabelMap(): Promise<LabelMap> {
  const { labels = [] } = await apiGet<{ labels?: GLabel[] }>(`${USER}/labels`);
  return new Map(labels.map((l) => [l.id, l]));
}

function userLabelChips(labelIds: string[], labels: LabelMap): LabelChip[] {
  const chips: LabelChip[] = [];
  for (const id of labelIds) {
    const l = labels.get(id);
    if (!l || l.type === "system") continue;
    chips.push({
      name: l.name,
      textColor: l.color?.textColor ?? "#3c4043",
      backgroundColor: l.color?.backgroundColor ?? "#e8eaed",
    });
  }
  return chips;
}

// --- list view ---------------------------------------------------------------

export async function listThreadViews(opts: {
  labelId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}): Promise<ListView> {
  const pageSize = opts.pageSize ?? 50;
  const page = opts.page ?? 0;

  const [list, labels] = await Promise.all([
    apiGet<{ threads?: Array<{ id: string; snippet?: string }>; resultSizeEstimate?: number }>(
      `${USER}/threads`,
      {
        maxResults: pageSize,
        pageToken: pageToken(page * pageSize),
        labelIds: opts.labelId || undefined,
        q: opts.q || undefined,
      },
    ),
    fetchLabelMap(),
  ]);

  const threads = list.threads ?? [];
  const rows = await Promise.all(
    threads.map(async (t): Promise<ThreadRow> => {
      const thread = await apiGet<GThread>(`${USER}/threads/${t.id}`, { format: "metadata" });
      const msgs = thread.messages ?? [];
      const latest = msgs[msgs.length - 1];
      const names: string[] = [];
      for (const m of msgs) {
        const n = displayName(header(m.payload, "from"));
        if (!names.includes(n)) names.push(n);
      }
      const allLabels = new Set(msgs.flatMap((m) => m.labelIds ?? []));
      const has = (label: string) => msgs.some((m) => (m.labelIds ?? []).includes(label));
      return {
        threadId: t.id,
        participants: names.join(", "),
        subject: header(latest?.payload, "subject") || "(no subject)",
        snippet: t.snippet ?? "",
        date: Number(latest?.internalDate ?? 0),
        unread: has("UNREAD"),
        starred: has("STARRED"),
        important: has("IMPORTANT"),
        hasAttachment: msgs.some((m) => hasAttachment(m.payload)),
        count: msgs.length,
        labels: userLabelChips([...allLabels], labels),
      };
    }),
  );

  return { rows, total: list.resultSizeEstimate ?? rows.length, page, pageSize };
}

// --- thread view -------------------------------------------------------------

export async function getThreadView(threadId: string): Promise<ThreadView | null> {
  let thread: GThread;
  try {
    thread = await apiGet<GThread>(`${USER}/threads/${threadId}`, { format: "full" });
  } catch {
    return null;
  }
  const msgs = thread.messages ?? [];
  if (msgs.length === 0) return null;
  const labels = await fetchLabelMap();

  const messages: ThreadMessageView[] = msgs.map((m) => {
    const name = displayName(header(m.payload, "from"));
    const { html, text } = extractBodies(m.payload);
    const labelIds = m.labelIds ?? [];
    return {
      id: m.id,
      fromName: name,
      fromAddr: header(m.payload, "from"),
      fromInitial: initial(name),
      to: header(m.payload, "to"),
      date: Number(m.internalDate ?? 0),
      snippet: m.snippet ?? "",
      html,
      text,
      unread: labelIds.includes("UNREAD"),
      labels: userLabelChips(labelIds, labels),
    };
  });

  const allLabels = new Set(msgs.flatMap((m) => m.labelIds ?? []));
  return {
    threadId,
    subject: header(msgs[0].payload, "subject") || "(no subject)",
    messages,
    labels: userLabelChips([...allLabels], labels),
  };
}

/** Mark every unread message in a thread read (Gmail opens do this). */
export async function markThreadRead(threadId: string): Promise<void> {
  const { apiPost } = await import("./api-client");
  await apiPost(`${USER}/threads/${threadId}/modify`, { removeLabelIds: ["UNREAD"] });
}

/** The mailbox owner's address, for the rail header + avatar. */
export async function profileEmail(): Promise<string> {
  const p = await apiGet<{ emailAddress?: string }>(`${USER}/profile`);
  return p.emailAddress ?? "";
}

// --- left rail ---------------------------------------------------------------

export async function railLabels(): Promise<RailLabel[]> {
  const { labels = [] } = await apiGet<{ labels?: GLabel[] }>(`${USER}/labels`);
  // labels.list omits counts; labels.get includes messagesUnread.
  return Promise.all(
    labels.map(async (l): Promise<RailLabel> => {
      const full = await apiGet<GLabel>(`${USER}/labels/${l.id}`);
      return {
        id: l.id,
        name: l.name,
        type: l.type ?? "user",
        unread: full.messagesUnread ?? 0,
        color: l.color?.textColor && l.color?.backgroundColor
          ? { textColor: l.color.textColor, backgroundColor: l.color.backgroundColor }
          : null,
      };
    }),
  );
}
