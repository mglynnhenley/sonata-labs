// Row shapes (as read from SQLite) and Slack Web API resource shapes. The
// resource types cover the fields the sandbox serves — enough for the official
// @slack/web-api SDK and typical agents; raw_json preserves anything richer.

// ---------------------------------------------------------------------------
// DB rows
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  team_id: string | null;
  name: string | null;
  real_name: string | null;
  display_name: string | null;
  tz: string | null;
  is_bot: number;
  is_admin: number;
  is_owner: number;
  deleted: number;
  updated: number;
  profile_json: string | null;
  raw_json: string;
}

export interface ConversationRow {
  id: string;
  name: string | null;
  is_channel: number;
  is_group: number;
  is_im: number;
  is_mpim: number;
  is_private: number;
  is_archived: number;
  is_general: number;
  creator: string | null;
  created: number;
  num_members: number;
  topic_json: string | null;
  purpose_json: string | null;
  raw_json: string;
}

export interface MessageRow {
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  user: string | null;
  bot_id: string | null;
  subtype: string | null;
  text: string | null;
  edited_ts: string | null;
  edited_user: string | null;
  reply_count: number;
  reply_users_count: number;
  latest_reply: string | null;
  has_files: number;
  blocks_json: string | null;
  raw_json: string;
  is_sandbox_created: number;
}

export interface FileRow {
  id: string;
  user: string | null;
  name: string | null;
  title: string | null;
  mimetype: string | null;
  filetype: string | null;
  size: number;
  created: number;
  url_private: string | null;
  permalink: string | null;
  data: Buffer | null;
  raw_json: string;
  is_sandbox_created: number;
}

// ---------------------------------------------------------------------------
// Slack API resources
// ---------------------------------------------------------------------------

export interface SlackTopicPurpose {
  value: string;
  creator: string;
  last_set: number;
}

export interface SlackUserProfile {
  real_name?: string;
  display_name?: string;
  real_name_normalized?: string;
  display_name_normalized?: string;
  title?: string;
  status_text?: string;
  status_emoji?: string;
  image_24?: string;
  image_48?: string;
  image_72?: string;
  email?: string;
  team?: string;
  [k: string]: unknown;
}

export interface SlackUser {
  id: string;
  team_id?: string;
  name?: string;
  deleted?: boolean;
  real_name?: string;
  tz?: string;
  tz_label?: string;
  tz_offset?: number;
  profile?: SlackUserProfile;
  is_admin?: boolean;
  is_owner?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  updated?: number;
  [k: string]: unknown;
}

export interface SlackConversation {
  id: string;
  name?: string;
  name_normalized?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_general?: boolean;
  is_member?: boolean;
  is_org_shared?: boolean;
  user?: string; // ims: the counterpart user
  creator?: string;
  created?: number;
  num_members?: number;
  topic?: SlackTopicPurpose;
  purpose?: SlackTopicPurpose;
  [k: string]: unknown;
}

export interface SlackReaction {
  name: string;
  users: string[];
  count: number;
}

export interface SlackMessage {
  type: "message";
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  team?: string;
  thread_ts?: string;
  reply_count?: number;
  reply_users_count?: number;
  latest_reply?: string;
  reply_users?: string[];
  edited?: { user?: string; ts: string };
  reactions?: SlackReaction[];
  files?: SlackFile[];
  blocks?: unknown[];
  pinned_to?: string[];
  [k: string]: unknown;
}

export interface SlackFile {
  id: string;
  created?: number;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  user?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  channels?: string[];
  [k: string]: unknown;
}
