import type { Database } from "better-sqlite3";
import type { ConversationRow, SlackConversation, SlackTopicPurpose } from "../slack/types";

export interface InsertConversationInput {
  id: string;
  name?: string | null;
  isChannel?: boolean;
  isGroup?: boolean;
  isIm?: boolean;
  isMpim?: boolean;
  isPrivate?: boolean;
  isArchived?: boolean;
  isGeneral?: boolean;
  creator?: string | null;
  created?: number;
  topicJson?: string | null;
  purposeJson?: string | null;
  rawJson: string;
}

export function insertConversation(db: Database, c: InsertConversationInput): void {
  db.prepare(
    `INSERT OR REPLACE INTO conversations
       (id, name, is_channel, is_group, is_im, is_mpim, is_private, is_archived, is_general,
        creator, created, num_members, topic_json, purpose_json, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    c.id,
    c.name ?? null,
    c.isChannel ? 1 : 0,
    c.isGroup ? 1 : 0,
    c.isIm ? 1 : 0,
    c.isMpim ? 1 : 0,
    c.isPrivate ? 1 : 0,
    c.isArchived ? 1 : 0,
    c.isGeneral ? 1 : 0,
    c.creator ?? null,
    c.created ?? 0,
    c.topicJson ?? null,
    c.purposeJson ?? null,
    c.rawJson,
  );
}

export function getConversation(db: Database, id: string): ConversationRow | undefined {
  return db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
    | ConversationRow
    | undefined;
}

export function getConversationByName(db: Database, name: string): ConversationRow | undefined {
  return db
    .prepare("SELECT * FROM conversations WHERE name = ? COLLATE NOCASE")
    .get(name) as ConversationRow | undefined;
}

export interface ListConversationsOpts {
  /** Slack `types` values: public_channel | private_channel | mpim | im. */
  types: string[];
  excludeArchived: boolean;
  afterId: string | null;
  limit: number;
}

/** Conversations ordered by id (stable, cursor-friendly). */
export function listConversations(db: Database, opts: ListConversationsOpts): ConversationRow[] {
  const typeClauses: string[] = [];
  for (const t of opts.types) {
    if (t === "public_channel") typeClauses.push("(is_channel = 1 AND is_private = 0)");
    else if (t === "private_channel")
      typeClauses.push("((is_group = 1 OR (is_channel = 1 AND is_private = 1)) AND is_mpim = 0)");
    else if (t === "mpim") typeClauses.push("(is_mpim = 1)");
    else if (t === "im") typeClauses.push("(is_im = 1)");
  }
  const typeSql = typeClauses.length ? `(${typeClauses.join(" OR ")})` : "0";
  const archivedSql = opts.excludeArchived ? "AND is_archived = 0" : "";
  const afterSql = opts.afterId ? "AND id > ?" : "";
  const params: unknown[] = [];
  if (opts.afterId) params.push(opts.afterId);
  params.push(opts.limit);
  return db
    .prepare(
      `SELECT * FROM conversations WHERE ${typeSql} ${archivedSql} ${afterSql} ORDER BY id LIMIT ?`,
    )
    .all(...params) as ConversationRow[];
}

// --- members ---------------------------------------------------------------

export function addMember(db: Database, conversationId: string, userId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)",
  ).run(conversationId, userId);
  refreshNumMembers(db, conversationId);
}

export function removeMember(db: Database, conversationId: string, userId: string): void {
  db.prepare(
    "DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
  ).run(conversationId, userId);
  refreshNumMembers(db, conversationId);
}

export function isMember(db: Database, conversationId: string, userId: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?")
    .get(conversationId, userId);
}

export function listMembers(
  db: Database,
  conversationId: string,
  afterId: string | null,
  limit: number,
): string[] {
  const rows = afterId
    ? db
        .prepare(
          "SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id > ? ORDER BY user_id LIMIT ?",
        )
        .all(conversationId, afterId, limit)
    : db
        .prepare(
          "SELECT user_id FROM conversation_members WHERE conversation_id = ? ORDER BY user_id LIMIT ?",
        )
        .all(conversationId, limit);
  return (rows as Array<{ user_id: string }>).map((r) => r.user_id);
}

function refreshNumMembers(db: Database, conversationId: string): void {
  db.prepare(
    `UPDATE conversations SET num_members =
       (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ?)
     WHERE id = ?`,
  ).run(conversationId, conversationId);
}

// --- mutations --------------------------------------------------------------

export function setArchived(db: Database, id: string, archived: boolean): void {
  db.prepare("UPDATE conversations SET is_archived = ? WHERE id = ?").run(archived ? 1 : 0, id);
}

export function setTopic(db: Database, id: string, topic: SlackTopicPurpose): void {
  db.prepare("UPDATE conversations SET topic_json = ? WHERE id = ?").run(JSON.stringify(topic), id);
}

export function setPurpose(db: Database, id: string, purpose: SlackTopicPurpose): void {
  db.prepare("UPDATE conversations SET purpose_json = ? WHERE id = ?").run(
    JSON.stringify(purpose),
    id,
  );
}

export function renameConversation(db: Database, id: string, name: string): void {
  db.prepare("UPDATE conversations SET name = ? WHERE id = ?").run(name, id);
}

// --- shaping ----------------------------------------------------------------

const EMPTY_TOPIC: SlackTopicPurpose = { value: "", creator: "", last_set: 0 };

/**
 * Shape a row into a conversations.info resource: raw_json + live columns
 * (archived state, name, topic/purpose, num_members are sources of truth in
 * the columns; raw_json carries the long tail of flags).
 */
export function shapeConversation(row: ConversationRow, selfId?: string, member?: boolean): SlackConversation {
  const base = JSON.parse(row.raw_json) as SlackConversation;
  const out: SlackConversation = {
    ...base,
    id: row.id,
    is_archived: !!row.is_archived,
    created: row.created || base.created,
  };
  if (row.is_im) {
    // ims omit name/topic/purpose; `user` (the counterpart) comes from raw_json.
    return out;
  }
  out.name = row.name ?? base.name;
  out.name_normalized = out.name;
  out.is_channel = !!row.is_channel;
  out.is_group = !!row.is_group;
  out.is_mpim = !!row.is_mpim;
  out.is_private = !!row.is_private;
  out.is_general = !!row.is_general;
  out.creator = row.creator ?? base.creator;
  out.num_members = row.num_members;
  out.topic = row.topic_json ? (JSON.parse(row.topic_json) as SlackTopicPurpose) : EMPTY_TOPIC;
  out.purpose = row.purpose_json
    ? (JSON.parse(row.purpose_json) as SlackTopicPurpose)
    : EMPTY_TOPIC;
  if (selfId !== undefined) out.is_member = !!member;
  return out;
}
