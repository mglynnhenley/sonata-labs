export interface LabelChip {
  name: string;
  textColor: string;
  backgroundColor: string;
}

export interface RailLabel {
  id: string;
  name: string;
  type: string;
  unread: number;
  color: { textColor: string; backgroundColor: string } | null;
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

export interface ActionRow {
  id: number;
  ts: number;
  method: string;
  endpoint: string;
  action_type: string | null;
  target_type: string | null;
  target_id: string | null;
  request_json: string | null;
  response_code: number | null;
  summary: string;
}

export interface SessionRow {
  id: string;
  started_at: number;
  note: string | null;
  action_count: number;
}

export interface ActivityData {
  sessions: SessionRow[];
  currentSessionId: string | null;
  actions: ActionRow[];
  outbox: Array<{ id: string; messageId: string; envelopeTo: string[]; createdAt: number }>;
}

// Gmail-style smart date: time if today, "MMM D" otherwise, "M/D/YY" if old.
export function smartDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
}

export function fullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
