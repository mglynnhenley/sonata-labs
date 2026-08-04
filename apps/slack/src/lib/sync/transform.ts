import type { InsertUserInput } from "../store/users";
import type { InsertConversationInput } from "../store/conversations";
import type { InsertMessageInput } from "../store/messages";
import type { SlackConversation, SlackMessage, SlackUser, SlackFile } from "../slack/types";

// Transform real Web API resources (from the sync CLI) into sandbox rows.
// raw_json keeps the resource as-is EXCEPT for the fields the sandbox owns
// live: reactions, thread stats, and pin state are stripped so reads always
// overlay the current values from their own tables (see slack/shape.ts).

export function userToRow(u: SlackUser): InsertUserInput {
  return {
    id: u.id,
    teamId: u.team_id ?? null,
    name: u.name ?? null,
    realName: u.real_name ?? u.profile?.real_name ?? null,
    displayName: u.profile?.display_name ?? null,
    tz: u.tz ?? null,
    isBot: !!u.is_bot,
    isAdmin: !!u.is_admin,
    isOwner: !!u.is_owner,
    deleted: !!u.deleted,
    updated: u.updated ?? 0,
    profileJson: u.profile ? JSON.stringify(u.profile) : null,
    rawJson: JSON.stringify(u),
  };
}

export function conversationToRow(c: SlackConversation): InsertConversationInput {
  return {
    id: c.id,
    name: c.name ?? null,
    isChannel: !!c.is_channel,
    isGroup: !!c.is_group,
    isIm: !!c.is_im,
    isMpim: !!c.is_mpim,
    isPrivate: !!c.is_private,
    isArchived: !!c.is_archived,
    isGeneral: !!c.is_general,
    creator: c.creator ?? null,
    created: c.created ?? 0,
    topicJson: c.topic ? JSON.stringify(c.topic) : null,
    purposeJson: c.purpose ? JSON.stringify(c.purpose) : null,
    rawJson: JSON.stringify(c),
  };
}

/** Strip the fields the sandbox recomputes on read. */
function stripLiveFields(m: SlackMessage): SlackMessage {
  const copy: SlackMessage = { ...m };
  delete copy.reactions;
  delete copy.reply_count;
  delete copy.reply_users_count;
  delete copy.reply_users;
  delete copy.latest_reply;
  delete copy.pinned_to;
  delete copy.files;
  return copy;
}

export interface MessageParts {
  input: InsertMessageInput;
  reactions: Array<{ name: string; users: string[] }>;
  fileIds: string[];
  files: SlackFile[];
  /** Present when this message roots a thread with replies to fetch. */
  threadRootTs: string | null;
}

export function messageToRow(channelId: string, m: SlackMessage): MessageParts {
  const ts = m.ts;
  const files = (m.files ?? []) as SlackFile[];
  const input: InsertMessageInput = {
    channelId,
    ts,
    // thread_ts is set on both roots and replies by Slack; keep it as-is so
    // refreshThreadStats can recompute counts from the stored replies.
    threadTs: m.thread_ts ?? null,
    user: m.user ?? null,
    botId: m.bot_id ?? null,
    subtype: m.subtype ?? null,
    text: m.text ?? "",
    editedTs: m.edited?.ts ?? null,
    editedUser: m.edited?.user ?? null,
    hasFiles: files.length > 0,
    blocksJson: m.blocks ? JSON.stringify(m.blocks) : null,
    rawJson: JSON.stringify(stripLiveFields(m)),
    isSandboxCreated: false,
  };
  return {
    input,
    reactions: (m.reactions ?? []).map((r) => ({ name: r.name, users: r.users })),
    fileIds: files.map((f) => f.id),
    files,
    threadRootTs: m.thread_ts === ts && (m.reply_count ?? 0) > 0 ? ts : null,
  };
}

export function fileToRow(f: SlackFile, data: Buffer | null) {
  return {
    id: f.id,
    user: f.user ?? null,
    name: f.name ?? null,
    title: f.title ?? null,
    mimetype: f.mimetype ?? null,
    filetype: f.filetype ?? null,
    size: f.size ?? 0,
    created: f.created ?? 0,
    urlPrivate: f.url_private ?? null,
    permalink: f.permalink ?? null,
    data,
    rawJson: JSON.stringify(f),
    isSandboxCreated: false,
  };
}
