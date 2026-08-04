import { ok } from "../envelope";
import { str, clampLimit } from "../args";
import { shapeMessage } from "../shape";
import { listReactedMessages } from "../../store/reactions";
import { getMessage } from "../../store/messages";
import { requireChannel, requireMessage } from "./helpers";
import type { MethodHandler } from "../route-helpers";

export const reactionsGet: MethodHandler = ({ db, args, self }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  const msg = requireMessage(db, row.id, str(args, "timestamp"));
  return ok({
    type: "message",
    channel: row.id,
    message: shapeMessage(db, msg),
  });
};

export const reactionsList: MethodHandler = ({ db, args, self }) => {
  const userId = str(args, "user") ?? self.userId;
  const limit = clampLimit(args, 100, 1000);
  const refs = listReactedMessages(db, userId, limit);
  const items = refs
    .map((r) => {
      const msg = getMessage(db, r.channel_id, r.message_ts);
      if (!msg) return null;
      return { type: "message", channel: r.channel_id, message: shapeMessage(db, msg) };
    })
    .filter(Boolean);
  return ok({ items, response_metadata: { next_cursor: "" } });
};
