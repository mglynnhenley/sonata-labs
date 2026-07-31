import { ok } from "../envelope";
import { str } from "../args";
import { listPins } from "../../store/pins";
import { getMessage } from "../../store/messages";
import { shapeMessage } from "../shape";
import { requireChannel } from "./helpers";
import type { MethodHandler } from "../route-helpers";

export const pinsList: MethodHandler = ({ db, args, self }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  const items = listPins(db, row.id)
    .map((p) => {
      const msg = getMessage(db, p.channel_id, p.message_ts);
      if (!msg) return null;
      return {
        type: "message",
        channel: p.channel_id,
        created: p.created,
        created_by: p.created_by,
        message: shapeMessage(db, msg),
      };
    })
    .filter(Boolean);
  return ok({ items });
};
