import { ok, SlackError } from "../envelope";
import { str, num, bool } from "../args";
import { mintTs, msToTs } from "../ts";
import { newHexId, newId } from "../ids";
import { runMutation, type MethodHandler } from "../route-helpers";
import { requireChannel, requireMessage } from "./helpers";
import { insertMessage, getMessage, updateMessageText, deleteMessage } from "../../store/messages";
import { isMember } from "../../store/conversations";
import { addOutboxRow, deleteOutboxRow, getOutboxRow, listOutbox } from "../../store/outbox";
import { shapeMessage } from "../shape";
import { permalinkFor } from "./search";
import {
  messagePosted,
  messageChanged,
  messageDeleted,
  channelTypeOf,
} from "../../events/events";
import type { ConversationRow } from "../types";
import type { Database } from "better-sqlite3";

function channelLabel(row: ConversationRow): string {
  return row.name ? `#${row.name}` : row.id;
}

function snippet(text: string, n = 60): string {
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

function requireWritable(row: ConversationRow): void {
  if (row.is_archived) throw new SlackError("is_archived");
}

/** blocks arrive as a JSON string (form encoding) or an array (JSON body). */
function parseBlocks(v: unknown): unknown[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      throw new SlackError("invalid_blocks");
    }
  }
  return null;
}

/**
 * Resolve a requested thread_ts to the actual thread root: threading onto a
 * reply threads onto its parent (Slack semantics).
 */
function resolveThreadTs(db: Database, channelId: string, threadTs: string | undefined): string | null {
  if (!threadTs) return null;
  const parent = getMessage(db, channelId, threadTs);
  if (!parent) throw new SlackError("message_not_found");
  return parent.thread_ts && parent.thread_ts !== parent.ts ? parent.thread_ts : parent.ts;
}

export const chatPostMessage: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  requireWritable(row);
  if (!isMember(db, row.id, self.userId)) throw new SlackError("not_in_channel");
  const text = str(args, "text") ?? "";
  const blocks = parseBlocks(args.blocks);
  if (!text && !blocks) throw new SlackError("no_text");

  const result = runMutation(
    db,
    () => {
      const ts = mintTs(db, row.id);
      const threadTs = resolveThreadTs(db, row.id, str(args, "thread_ts"));
      insertMessage(db, {
        channelId: row.id,
        ts,
        threadTs,
        user: self.userId,
        text,
        blocksJson: blocks ? JSON.stringify(blocks) : null,
        rawJson: JSON.stringify({ type: "message", user: self.userId, text, ts, team: self.teamId }),
        isSandboxCreated: true,
      });
      addOutboxRow(db, {
        id: newHexId(),
        channelId: row.id,
        messageTs: ts,
        request: { ...args, token: undefined },
        createdAt: Date.now(),
      });
      return { ts, threadTs };
    },
    ({ ts, threadTs }) => ({
      method: httpMethod,
      endpoint: method,
      actionType: "post",
      targetType: "message",
      targetId: `${row.id}/${ts}`,
      request: { channel: row.id, text, thread_ts: threadTs ?? undefined },
      responseCode: 200,
      summary: threadTs
        ? `replied in thread in ${channelLabel(row)}: "${snippet(text)}"`
        : `posted to ${channelLabel(row)}: "${snippet(text)}"`,
    }),
  );

  const msg = getMessage(db, row.id, result.ts)!;
  // Emitted only after the transaction committed — subscribers never see an
  // event for a write that did not land.
  messagePosted({
    channel: row.id,
    ts: result.ts,
    user: self.userId,
    text,
    threadTs: result.threadTs,
    channelType: channelTypeOf(row),
  });
  return ok({ channel: row.id, ts: result.ts, message: shapeMessage(db, msg) });
};

export const chatUpdate: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  requireWritable(row);
  const msg = requireMessage(db, row.id, str(args, "ts"));
  const text = str(args, "text") ?? "";
  const blocks = parseBlocks(args.blocks);
  if (!text && !blocks) throw new SlackError("no_text");

  runMutation(
    db,
    () => {
      updateMessageText(
        db,
        row.id,
        msg.ts,
        text,
        self.userId,
        msToTs(Date.now()),
        blocks ? JSON.stringify(blocks) : null,
      );
    },
    () => ({
      method: httpMethod,
      endpoint: method,
      actionType: "update",
      targetType: "message",
      targetId: `${row.id}/${msg.ts}`,
      request: { channel: row.id, ts: msg.ts, text },
      responseCode: 200,
      summary: `edited message in ${channelLabel(row)}: "${snippet(text)}"`,
    }),
  );

  const updated = getMessage(db, row.id, msg.ts)!;
  messageChanged({
    channel: row.id,
    ts: msg.ts,
    user: self.userId,
    text,
    channelType: channelTypeOf(row),
    editedTs: updated.edited_ts ?? msg.ts,
  });
  return ok({ channel: row.id, ts: msg.ts, text, message: shapeMessage(db, updated) });
};

export const chatDelete: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  const msg = requireMessage(db, row.id, str(args, "ts"));

  runMutation(
    db,
    () => deleteMessage(db, row.id, msg.ts),
    () => ({
      method: httpMethod,
      endpoint: method,
      actionType: "delete",
      targetType: "message",
      targetId: `${row.id}/${msg.ts}`,
      request: { channel: row.id, ts: msg.ts },
      responseCode: 200,
      summary: `deleted message in ${channelLabel(row)}: "${snippet(msg.text ?? "")}"`,
    }),
  );

  messageDeleted({
    channel: row.id,
    ts: msg.ts,
    channelType: channelTypeOf(row),
    deletedTs: msToTs(Date.now()),
  });
  return ok({ channel: row.id, ts: msg.ts });
};

export const chatGetPermalink: MethodHandler = ({ db, args, self }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  const msg = requireMessage(db, row.id, str(args, "message_ts"));
  return ok({ channel: row.id, permalink: permalinkFor(self, row.id, msg.ts) });
};

export const chatPostEphemeral: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  requireWritable(row);
  const text = str(args, "text") ?? "";
  if (!text) throw new SlackError("no_text");
  const user = str(args, "user");
  if (!user) throw new SlackError("user_not_found");
  // Ephemeral messages are never stored (matching Slack — they're not in
  // history); the audit log still records the attempt.
  const ts = runMutation(
    db,
    () => msToTs(Date.now()),
    (messageTs) => ({
      method: httpMethod,
      endpoint: method,
      actionType: "post_ephemeral",
      targetType: "message",
      targetId: `${row.id}/${messageTs}`,
      request: { channel: row.id, user, text },
      responseCode: 200,
      summary: `posted ephemeral to ${user} in ${channelLabel(row)}: "${snippet(text)}"`,
    }),
  );
  return ok({ message_ts: ts });
};

export const chatScheduleMessage: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  requireWritable(row);
  const text = str(args, "text") ?? "";
  if (!text) throw new SlackError("no_text");
  const postAt = num(args, "post_at");
  if (!postAt) throw new SlackError("invalid_time");
  if (postAt * 1000 <= Date.now()) throw new SlackError("time_in_past");

  const id = runMutation(
    db,
    () => {
      const scheduledId = newId("Q");
      addOutboxRow(db, {
        id: scheduledId,
        channelId: row.id,
        messageTs: msToTs(postAt * 1000),
        postAt,
        request: { channel: row.id, text, post_at: postAt },
        createdAt: Date.now(),
      });
      return scheduledId;
    },
    (scheduledId) => ({
      method: httpMethod,
      endpoint: method,
      actionType: "schedule",
      targetType: "message",
      targetId: scheduledId,
      request: { channel: row.id, text, post_at: postAt },
      responseCode: 200,
      summary: `scheduled message for ${new Date(postAt * 1000).toISOString()} in ${channelLabel(row)}: "${snippet(text)}"`,
    }),
  );

  return ok({
    channel: row.id,
    scheduled_message_id: id,
    post_at: postAt,
    message: { type: "message", user: self.userId, text, team: self.teamId },
  });
};

export const chatDeleteScheduledMessage: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  const id = str(args, "scheduled_message_id");
  const existing = id ? getOutboxRow(db, id) : undefined;
  if (!existing || existing.post_at == null || existing.channel_id !== row.id) {
    throw new SlackError("invalid_scheduled_message_id");
  }
  runMutation(
    db,
    () => deleteOutboxRow(db, existing.id),
    () => ({
      method: httpMethod,
      endpoint: method,
      actionType: "unschedule",
      targetType: "message",
      targetId: existing.id,
      request: { channel: row.id, scheduled_message_id: existing.id },
      responseCode: 200,
      summary: `deleted scheduled message ${existing.id} in ${channelLabel(row)}`,
    }),
  );
  return ok({});
};

export const chatScheduledMessagesList: MethodHandler = ({ db, args }) => {
  const channel = str(args, "channel");
  const rows = listOutbox(db, { scheduledOnly: true, channelId: channel ?? undefined });
  return ok({
    scheduled_messages: rows.map((r) => {
      const req = r.request_json ? (JSON.parse(r.request_json) as { text?: string }) : {};
      return {
        id: r.id,
        channel_id: r.channel_id,
        post_at: r.post_at,
        date_created: Math.floor(r.created_at / 1000),
        text: req.text ?? "",
      };
    }),
    response_metadata: { next_cursor: "" },
  });
};
