import { ok, SlackError } from "../envelope";
import { bool, clampLimit, str } from "../args";
import { decodeCursor, cursorMeta } from "../cursor";
import {
  listConversations,
  listMembers,
  isMember,
  shapeConversation,
} from "../../store/conversations";
import { getHistory, getReplies } from "../../store/messages";
import { listPins } from "../../store/pins";
import { unreadCounts } from "../../store/read-state";
import { shapeMessage } from "../shape";
import { requireChannel } from "./helpers";
import type { MethodHandler } from "../route-helpers";
import type { MessageRow } from "../types";

export const conversationsList: MethodHandler = ({ db, args, self }) => {
  const types = (str(args, "types") ?? "public_channel").split(",").map((t) => t.trim());
  const limit = clampLimit(args, 100, 1000);
  const afterId = decodeCursor(str(args, "cursor"));
  const excludeArchived = bool(args, "exclude_archived") ?? false;
  const all = listConversations(db, { types, excludeArchived, afterId, limit: limit + 1 });
  // Private conversations the self user isn't in are invisible.
  const visible = all.filter(
    (c) => !c.is_private || isMember(db, c.id, self.userId),
  );
  const page = visible.slice(0, limit);
  const nextAnchor = visible.length > limit ? page[page.length - 1].id : null;
  return ok({
    channels: page.map((c) => shapeConversation(c, self.userId, isMember(db, c.id, self.userId))),
    response_metadata: cursorMeta(nextAnchor),
  });
};

export const conversationsInfo: MethodHandler = ({ db, args, self }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  const channel = shapeConversation(row, self.userId, isMember(db, row.id, self.userId));
  // Slack returns read state on conversations.info for members.
  if (isMember(db, row.id, self.userId)) {
    const counts = unreadCounts(db, row.id, self.userId, {
      isDm: !!row.is_im || !!row.is_mpim,
    });
    channel.last_read = counts.lastRead;
    channel.unread_count = counts.unread;
    channel.unread_count_display = counts.display;
  }
  return ok({ channel });
};

export const conversationsHistory: MethodHandler = ({ db, args, self }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  const limit = clampLimit(args, 100, 999);
  const cursorTs = decodeCursor(str(args, "cursor"));
  const inclusive = bool(args, "inclusive") ?? false;
  // A cursor anchors strictly-older-than the last ts of the previous page and
  // overrides any `latest` arg (matching Slack's cursor-wins behavior).
  const rows = getHistory(db, row.id, {
    oldest: str(args, "oldest") ?? null,
    latest: cursorTs ?? str(args, "latest") ?? null,
    inclusive: cursorTs ? false : inclusive,
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const nextAnchor = hasMore ? page[page.length - 1].ts : null;
  return ok({
    messages: page.map((m: MessageRow) => shapeMessage(db, m)),
    has_more: hasMore,
    pin_count: listPins(db, row.id).length,
    response_metadata: cursorMeta(nextAnchor),
  });
};

export const conversationsReplies: MethodHandler = ({ db, args, self }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  const ts = str(args, "ts");
  if (!ts) throw new SlackError("thread_not_found");
  const limit = clampLimit(args, 100, 999);
  const cursorTs = decodeCursor(str(args, "cursor"));
  const rows = getReplies(db, row.id, ts, {
    // Replies are oldest-first; a cursor anchors strictly-newer-than the last
    // reply of the previous page. The parent repeats on every page (Slack does).
    oldest: cursorTs ?? str(args, "oldest") ?? null,
    latest: str(args, "latest") ?? null,
    inclusive: cursorTs ? false : bool(args, "inclusive") ?? false,
    limit: limit + 1,
  });
  if (!rows.length) throw new SlackError("thread_not_found");
  const [parent, ...replies] = rows;
  const page = replies.slice(0, limit);
  const hasMore = replies.length > limit;
  const nextAnchor = hasMore ? page[page.length - 1].ts : null;
  return ok({
    messages: [parent, ...page].map((m) => shapeMessage(db, m)),
    has_more: hasMore,
    response_metadata: cursorMeta(nextAnchor),
  });
};

export const conversationsMembers: MethodHandler = ({ db, args, self }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  const limit = clampLimit(args, 100, 1000);
  const afterId = decodeCursor(str(args, "cursor"));
  const ids = listMembers(db, row.id, afterId, limit + 1);
  const page = ids.slice(0, limit);
  const nextAnchor = ids.length > limit ? page[page.length - 1] : null;
  return ok({ members: page, response_metadata: cursorMeta(nextAnchor) });
};
