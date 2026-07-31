// Client-side mirrors of the view models in src/lib/ui/views.ts.

export interface UiUser {
  id: string;
  name: string;
  realName: string;
  initials: string;
  color: string;
  isBot: boolean;
}

export interface UiReaction {
  name: string;
  count: number;
  reactedBySelf: boolean;
  users: string[];
}

export interface UiFile {
  id: string;
  name: string;
  title: string;
  filetype: string;
  size: number;
}

export interface UiMessage {
  ts: string;
  timeMs: number;
  author: UiUser;
  text: string;
  blocks: unknown[] | null;
  edited: boolean;
  reactions: UiReaction[];
  files: UiFile[];
  pinned: boolean;
  isSandboxCreated: boolean;
  replyCount: number;
  replyUsers: UiUser[];
  latestReplyMs: number | null;
  continuation: boolean;
  dayDivider: string | null;
}

export type ChannelKind = "channel" | "private" | "im" | "mpim";

export interface UiChannelSummary {
  id: string;
  name: string;
  kind: ChannelKind;
  isMember: boolean;
  isArchived: boolean;
  isGeneral: boolean;
  partner: UiUser | null;
  memberCount: number;
  lastMessageMs: number | null;
  unread: number;
  badge: number;
}

export interface Directories {
  users: Record<string, string>;
  channels: Record<string, string>;
}

export interface SidebarData {
  self: UiUser;
  team: { name: string; domain: string };
  channels: UiChannelSummary[];
  dms: UiChannelSummary[];
  directories: Directories;
}

export interface ChannelData {
  channel: {
    id: string;
    name: string;
    kind: ChannelKind;
    topic: string;
    purpose: string;
    memberCount: number;
    isArchived: boolean;
    partner: UiUser | null;
  };
  messages: UiMessage[];
}

export interface ThreadData {
  channel: { id: string; name: string; kind: ChannelKind };
  parent: UiMessage | null;
  replies: UiMessage[];
}

export interface SearchMatch {
  channelId: string;
  channelName: string;
  channelKind: ChannelKind;
  ts: string;
  timeMs: number;
  author: UiUser;
  text: string;
  threadTs: string | null;
}

export interface SearchData {
  query: string;
  total: number;
  matches: SearchMatch[];
}

export interface ActionRow {
  id: number;
  session_id: string;
  ts: number;
  method: string;
  endpoint: string;
  action_type: string | null;
  target_type: string | null;
  target_id: string | null;
  request: unknown;
  response_code: number | null;
  summary: string;
}

export interface SessionRow {
  id: string;
  started_at: number;
  note: string | null;
  action_count: number;
}

export interface OutboxRow {
  id: string;
  channel_id: string;
  message_ts: string;
  post_at: number | null;
  request: unknown;
  created_at: number;
}

export interface ActivityData {
  sessions: SessionRow[];
  session_id: string;
  actions: ActionRow[];
  outbox: OutboxRow[];
}
