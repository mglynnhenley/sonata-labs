import { ok, SlackError } from "../envelope";
import { str } from "../args";
import { runMutation, type MethodHandler } from "../route-helpers";
import { requireChannel, requireMessage } from "./helpers";
import { addPin, removePin } from "../../store/pins";
import { pinAdded, pinRemoved } from "../../events/events";
import type { ConversationRow } from "../types";

function channelLabel(row: ConversationRow): string {
  return row.name ? `#${row.name}` : row.id;
}

export const pinsAdd: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  if (row.is_archived) throw new SlackError("is_archived");
  const msg = requireMessage(db, row.id, str(args, "timestamp") ?? str(args, "ts"));

  const added = runMutation(
    db,
    () => addPin(db, row.id, msg.ts, self.userId, Math.floor(Date.now() / 1000)),
    (ok_) => ({
      method: httpMethod,
      endpoint: method,
      actionType: "pin",
      targetType: "message",
      targetId: `${row.id}/${msg.ts}`,
      request: { channel: row.id, timestamp: msg.ts },
      responseCode: 200,
      summary: ok_
        ? `pinned a message in ${channelLabel(row)}`
        : `no-op pin (already pinned) in ${channelLabel(row)}`,
    }),
  );
  if (!added) throw new SlackError("already_pinned");
  pinAdded({ user: self.userId, channel: row.id, ts: msg.ts });
  return ok({});
};

export const pinsRemove: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  const msg = requireMessage(db, row.id, str(args, "timestamp") ?? str(args, "ts"));

  const removed = runMutation(
    db,
    () => removePin(db, row.id, msg.ts),
    (ok_) => ({
      method: httpMethod,
      endpoint: method,
      actionType: "unpin",
      targetType: "message",
      targetId: `${row.id}/${msg.ts}`,
      request: { channel: row.id, timestamp: msg.ts },
      responseCode: 200,
      summary: ok_
        ? `unpinned a message in ${channelLabel(row)}`
        : `no-op unpin (not pinned) in ${channelLabel(row)}`,
    }),
  );
  if (!removed) throw new SlackError("no_pin");
  pinRemoved({ user: self.userId, channel: row.id, ts: msg.ts });
  return ok({});
};
