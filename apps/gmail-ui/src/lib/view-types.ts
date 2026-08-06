// View-model shapes the Gmail-replica UI consumes. These are the exact shapes
// the API app's old /api/ui routes returned — reproduced here so the relocated
// React components need no changes. The BFF (gmail-views.ts) builds these from
// the public /gmail/v1 surface; the activity proxy supplies ActivityData.

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
