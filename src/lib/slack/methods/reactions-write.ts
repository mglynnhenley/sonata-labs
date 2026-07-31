import { ok, SlackError } from "../envelope";
import { str } from "../args";
import { runMutation, type MethodHandler } from "../route-helpers";
import { requireChannel, requireMessage } from "./helpers";
import { addReaction, removeReaction } from "../../store/reactions";
import { reactionAdded, reactionRemoved } from "../../events/events";
import type { ConversationRow } from "../types";

function channelLabel(row: ConversationRow): string {
  return row.name ? `#${row.name}` : row.id;
}

/** Emoji names arrive bare ("thumbsup"); tolerate wrapping colons. */
function normalizeName(raw: string | undefined): string {
  if (!raw) throw new SlackError("invalid_name");
  const name = raw.replace(/^:|:$/g, "").trim();
  if (!name) throw new SlackError("invalid_name");
  return name;
}

export const reactionsAdd: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  if (row.is_archived) throw new SlackError("is_archived");
  const msg = requireMessage(db, row.id, str(args, "timestamp"));
  const name = normalizeName(str(args, "name"));

  const added = runMutation(
    db,
    () => addReaction(db, row.id, msg.ts, name, self.userId),
    (ok_) => ({
      method: httpMethod,
      endpoint: method,
      actionType: "react",
      targetType: "message",
      targetId: `${row.id}/${msg.ts}`,
      request: { channel: row.id, timestamp: msg.ts, name },
      responseCode: 200,
      summary: ok_
        ? `added :${name}: in ${channelLabel(row)}`
        : `no-op :${name}: (already reacted) in ${channelLabel(row)}`,
    }),
  );
  if (!added) throw new SlackError("already_reacted");
  reactionAdded({
    user: self.userId,
    reaction: name,
    channel: row.id,
    ts: msg.ts,
    itemUser: msg.user,
  });
  return ok({});
};

export const reactionsRemove: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  const msg = requireMessage(db, row.id, str(args, "timestamp"));
  const name = normalizeName(str(args, "name"));

  const removed = runMutation(
    db,
    () => removeReaction(db, row.id, msg.ts, name, self.userId),
    (ok_) => ({
      method: httpMethod,
      endpoint: method,
      actionType: "unreact",
      targetType: "message",
      targetId: `${row.id}/${msg.ts}`,
      request: { channel: row.id, timestamp: msg.ts, name },
      responseCode: 200,
      summary: ok_
        ? `removed :${name}: in ${channelLabel(row)}`
        : `no-op remove :${name}: (no reaction) in ${channelLabel(row)}`,
    }),
  );
  if (!removed) throw new SlackError("no_reaction");
  reactionRemoved({
    user: self.userId,
    reaction: name,
    channel: row.id,
    ts: msg.ts,
    itemUser: msg.user,
  });
  return ok({});
};
