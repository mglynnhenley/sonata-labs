import type { Database } from "better-sqlite3";
import { listThreads } from "../store/threads";
import { getMessageRow, getLabelIds, messageIdsInThread } from "../store/messages";
import { listLabelRows, computeLabelCounts } from "../store/labels";
import { compileQuery } from "../search/compile";
import { shapeMessage } from "../gmail/shape";
import type { GmailPayload } from "../gmail/types";
import { b64urlDecode } from "../gmail/base64";
import { SYSTEM_LABELS } from "../gmail/types";

// View models for the Gmail-replica UI. The UI polls the /api/ui/* routes that
// wrap these; they read straight from the working DB (same process, no auth).

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

export interface LabelChip {
  name: string;
  textColor: string;
  backgroundColor: string;
}

function userLabelChips(db: Database, labelIds: string[]): LabelChip[] {
  const chips: LabelChip[] = [];
  for (const id of labelIds) {
    if ((SYSTEM_LABELS as readonly string[]).includes(id)) continue;
    const row = listLabelRows(db).find((l) => l.id === id);
    if (!row) continue;
    const color = row.color_json ? JSON.parse(row.color_json) : null;
    chips.push({
      name: row.name,
      textColor: color?.textColor ?? "#3c4043",
      backgroundColor: color?.backgroundColor ?? "#e8eaed",
    });
  }
  return chips;
}

export interface ThreadRow {
  threadId: string;
  participants: string;
  subject: string;
  snippet: string;
  date: number;
  unread: boolean;
  starred: boolean;
  important: boolean;
  hasAttachment: boolean;
  count: number;
  labels: LabelChip[];
}

export interface ListView {
  rows: ThreadRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function listThreadViews(
  db: Database,
  opts: { labelId?: string; q?: string; page?: number; pageSize?: number },
): ListView {
  const pageSize = opts.pageSize ?? 50;
  const page = opts.page ?? 0;
  const search = opts.q ? compileQuery(db, opts.q) : null;
  const labelIds = opts.labelId ? [opts.labelId] : [];

  const { threads, total } = listThreads(db, {
    labelIds,
    search,
    offset: page * pageSize,
    limit: pageSize,
  });

  const rows: ThreadRow[] = threads.map((t) => {
    const ids = messageIdsInThread(db, t.id);
    const msgs = ids.map((id) => ({ row: getMessageRow(db, id)!, labels: getLabelIds(db, id) }));
    const latest = msgs[msgs.length - 1];
    const names: string[] = [];
    for (const m of msgs) {
      const n = displayName(m.row.from_addr);
      if (!names.includes(n)) names.push(n);
    }
    const allLabels = new Set(msgs.flatMap((m) => m.labels));
    return {
      threadId: t.id,
      participants: names.join(", "),
      subject: latest.row.subject || "(no subject)",
      snippet: t.snippet,
      date: latest.row.internal_date,
      unread: msgs.some((m) => m.labels.includes("UNREAD")),
      starred: msgs.some((m) => m.labels.includes("STARRED")),
      important: msgs.some((m) => m.labels.includes("IMPORTANT")),
      hasAttachment: msgs.some((m) => m.row.has_attachment === 1),
      count: msgs.length,
      labels: userLabelChips(db, [...allLabels]),
    };
  });

  return { rows, total, page, pageSize };
}

// --- thread view -------------------------------------------------------------

function extractHtml(payload: GmailPayload | undefined): { html: string | null; text: string | null } {
  let html: string | null = null;
  let text: string | null = null;
  const walk = (p: GmailPayload) => {
    if (p.body?.data) {
      const decoded = b64urlDecode(p.body.data).toString("utf8");
      if (p.mimeType === "text/html" && html == null) html = decoded;
      else if (p.mimeType === "text/plain" && text == null) text = decoded;
    }
    for (const c of p.parts ?? []) walk(c);
  };
  if (payload) walk(payload);
  return { html, text };
}

export interface ThreadMessageView {
  id: string;
  fromName: string;
  fromAddr: string;
  fromInitial: string;
  to: string;
  date: number;
  snippet: string;
  html: string | null;
  text: string | null;
  unread: boolean;
  labels: LabelChip[];
}

export interface ThreadView {
  threadId: string;
  subject: string;
  messages: ThreadMessageView[];
  labels: LabelChip[];
}

export function getThreadView(db: Database, threadId: string): ThreadView | null {
  const ids = messageIdsInThread(db, threadId);
  if (ids.length === 0) return null;
  const messages: ThreadMessageView[] = ids.map((id) => {
    const row = getMessageRow(db, id)!;
    const labels = getLabelIds(db, id);
    const shaped = shapeMessage(row, labels, "full");
    const { html, text } = extractHtml(shaped.payload ?? undefined);
    const name = displayName(row.from_addr);
    return {
      id,
      fromName: name,
      fromAddr: row.from_addr || "",
      fromInitial: initial(name),
      to: row.to_addrs || "",
      date: row.internal_date,
      snippet: row.snippet,
      html,
      text,
      unread: labels.includes("UNREAD"),
      labels: userLabelChips(db, labels),
    };
  });
  const first = getMessageRow(db, ids[0])!;
  const allLabels = new Set(ids.flatMap((id) => getLabelIds(db, id)));
  return {
    threadId,
    subject: first.subject || "(no subject)",
    messages,
    labels: userLabelChips(db, [...allLabels]),
  };
}

// --- left rail ---------------------------------------------------------------

export interface RailLabel {
  id: string;
  name: string;
  type: string;
  unread: number;
  color: { textColor: string; backgroundColor: string } | null;
}

export function railLabels(db: Database): RailLabel[] {
  return listLabelRows(db).map((l) => ({
    id: l.id,
    name: l.name,
    type: l.type,
    unread: computeLabelCounts(db, l.id).messagesUnread,
    color: l.color_json ? JSON.parse(l.color_json) : null,
  }));
}
