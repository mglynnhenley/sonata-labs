import type { Database } from "better-sqlite3";
import { SlackError } from "../envelope";
import { getConversation, isMember } from "../../store/conversations";
import { getMessage } from "../../store/messages";
import type { ConversationRow, MessageRow } from "../types";

/**
 * Resolve a channel the caller can see. Private conversations the self user
 * isn't a member of are invisible — Slack reports them as channel_not_found
 * (not a permission error), and we match that.
 */
export function requireChannel(db: Database, channelId: string | undefined, selfId: string): ConversationRow {
  if (!channelId) throw new SlackError("channel_not_found");
  const row = getConversation(db, channelId);
  if (!row) throw new SlackError("channel_not_found");
  if (row.is_private && !isMember(db, row.id, selfId)) {
    throw new SlackError("channel_not_found");
  }
  return row;
}

export function requireMessage(db: Database, channelId: string, ts: string | undefined): MessageRow {
  if (!ts) throw new SlackError("message_not_found");
  const row = getMessage(db, channelId, ts);
  if (!row) throw new SlackError("message_not_found");
  return row;
}
