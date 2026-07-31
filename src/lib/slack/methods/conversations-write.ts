import { ok, SlackError } from "../envelope";
import { str, bool } from "../args";
import { newChannelId, newImId, newGroupId } from "../ids";
import { runMutation, type MethodHandler } from "../route-helpers";
import { requireChannel } from "./helpers";
import {
  insertConversation,
  getConversationByName,
  getConversation,
  addMember,
  removeMember,
  isMember,
  setArchived,
  setTopic,
  setPurpose,
  renameConversation,
  shapeConversation,
  listConversations,
} from "../../store/conversations";
import { getUser } from "../../store/users";
import { setLastRead } from "../../store/read-state";
import {
  channelCreated,
  memberJoined,
  memberLeft,
  channelArchive,
  channelTypeOf,
} from "../../events/events";
import type { ConversationRow } from "../types";

function channelLabel(row: ConversationRow): string {
  return row.name ? `#${row.name}` : row.id;
}

/** Slack channel names: lowercase, no spaces/periods, max 80 chars. */
function normalizeChannelName(raw: string | undefined): string {
  if (!raw) throw new SlackError("invalid_name_required");
  const name = raw.trim().toLowerCase().replace(/^#/, "");
  if (!name) throw new SlackError("invalid_name_required");
  if (name.length > 80) throw new SlackError("invalid_name_maxlength");
  if (/[\s.]/.test(name)) throw new SlackError("invalid_name_punctuation");
  return name;
}

export const conversationsCreate: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const name = normalizeChannelName(str(args, "name"));
  if (getConversationByName(db, name)) throw new SlackError("name_taken");
  const isPrivate = bool(args, "is_private") ?? false;

  const id = runMutation(
    db,
    () => {
      const newId = isPrivate ? newGroupId() : newChannelId();
      const created = Math.floor(Date.now() / 1000);
      insertConversation(db, {
        id: newId,
        name,
        isChannel: !isPrivate,
        isGroup: isPrivate,
        isPrivate,
        creator: self.userId,
        created,
        rawJson: JSON.stringify({
          id: newId,
          name,
          is_channel: !isPrivate,
          is_group: isPrivate,
          is_private: isPrivate,
          created,
          creator: self.userId,
          is_archived: false,
          is_general: false,
          is_member: true,
          name_normalized: name,
        }),
      });
      // The creator joins automatically.
      addMember(db, newId, self.userId);
      return newId;
    },
    (newId) => ({
      method: httpMethod,
      endpoint: method,
      actionType: "create_channel",
      targetType: "conversation",
      targetId: newId,
      request: { name, is_private: isPrivate },
      responseCode: 200,
      summary: `created ${isPrivate ? "private " : ""}channel #${name}`,
    }),
  );

  const row = getConversation(db, id)!;
  channelCreated({ id, name, creator: self.userId, created: row.created });
  memberJoined({ user: self.userId, channel: id, channelType: channelTypeOf(row) });
  return ok({ channel: shapeConversation(row, self.userId, true) });
};

export const conversationsInvite: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  if (row.is_archived) throw new SlackError("is_archived");
  if (row.is_im) throw new SlackError("method_not_supported_for_channel_type");
  const users = (str(args, "users") ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (!users.length) throw new SlackError("no_user");
  for (const u of users) {
    if (!getUser(db, u)) throw new SlackError("user_not_found");
    if (isMember(db, row.id, u)) throw new SlackError("already_in_channel");
  }

  runMutation(
    db,
    () => {
      for (const u of users) addMember(db, row.id, u);
    },
    () => ({
      method: httpMethod,
      endpoint: method,
      actionType: "invite",
      targetType: "conversation",
      targetId: row.id,
      request: { channel: row.id, users },
      responseCode: 200,
      summary: `invited ${users.length} user(s) to ${channelLabel(row)}`,
    }),
  );

  const updated = getConversation(db, row.id)!;
  for (const u of users) {
    memberJoined({
      user: u,
      channel: row.id,
      channelType: channelTypeOf(row),
      inviter: self.userId,
    });
  }
  return ok({ channel: shapeConversation(updated, self.userId, isMember(db, row.id, self.userId)) });
};

export const conversationsJoin: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  if (row.is_archived) throw new SlackError("is_archived");
  if (row.is_private) throw new SlackError("method_not_supported_for_channel_type");
  const already = isMember(db, row.id, self.userId);

  if (!already) {
    runMutation(
      db,
      () => addMember(db, row.id, self.userId),
      () => ({
        method: httpMethod,
        endpoint: method,
        actionType: "join",
        targetType: "conversation",
        targetId: row.id,
        request: { channel: row.id },
        responseCode: 200,
        summary: `joined ${channelLabel(row)}`,
      }),
    );
    memberJoined({ user: self.userId, channel: row.id, channelType: channelTypeOf(row) });
  }
  const updated = getConversation(db, row.id)!;
  return ok({ channel: shapeConversation(updated, self.userId, true) });
};

export const conversationsLeave: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  if (row.is_general) throw new SlackError("cant_leave_general");
  if (!isMember(db, row.id, self.userId)) return ok({ not_in_channel: true });

  runMutation(
    db,
    () => removeMember(db, row.id, self.userId),
    () => ({
      method: httpMethod,
      endpoint: method,
      actionType: "leave",
      targetType: "conversation",
      targetId: row.id,
      request: { channel: row.id },
      responseCode: 200,
      summary: `left ${channelLabel(row)}`,
    }),
  );
  memberLeft({ user: self.userId, channel: row.id, channelType: channelTypeOf(row) });
  return ok({});
};

function archiveHandler(archived: boolean): MethodHandler {
  return ({ db, args, self, method, httpMethod }) => {
    const row = requireChannel(db, str(args, "channel"), self.userId);
    if (archived && row.is_general) throw new SlackError("cant_archive_general");
    if (archived && row.is_archived) throw new SlackError("already_archived");
    if (!archived && !row.is_archived) throw new SlackError("not_archived");

    runMutation(
      db,
      () => setArchived(db, row.id, archived),
      () => ({
        method: httpMethod,
        endpoint: method,
        actionType: archived ? "archive" : "unarchive",
        targetType: "conversation",
        targetId: row.id,
        request: { channel: row.id },
        responseCode: 200,
        summary: `${archived ? "archived" : "unarchived"} ${channelLabel(row)}`,
      }),
    );
    channelArchive({ channel: row.id, user: self.userId, archived });
    return ok({});
  };
}

export const conversationsArchive = archiveHandler(true);
export const conversationsUnarchive = archiveHandler(false);

function topicPurposeHandler(kind: "topic" | "purpose"): MethodHandler {
  return ({ db, args, self, method, httpMethod }) => {
    const row = requireChannel(db, str(args, "channel"), self.userId);
    if (row.is_archived) throw new SlackError("is_archived");
    const value = str(args, kind) ?? "";
    const payload = { value, creator: self.userId, last_set: Math.floor(Date.now() / 1000) };

    runMutation(
      db,
      () => (kind === "topic" ? setTopic(db, row.id, payload) : setPurpose(db, row.id, payload)),
      () => ({
        method: httpMethod,
        endpoint: method,
        actionType: `set_${kind}`,
        targetType: "conversation",
        targetId: row.id,
        request: { channel: row.id, [kind]: value },
        responseCode: 200,
        summary: `set ${kind} of ${channelLabel(row)} to "${value.slice(0, 60)}"`,
      }),
    );

    const updated = getConversation(db, row.id)!;
    return ok({
      channel: shapeConversation(updated, self.userId, isMember(db, row.id, self.userId)),
      [kind]: value,
    });
  };
}

export const conversationsSetTopic = topicPurposeHandler("topic");
export const conversationsSetPurpose = topicPurposeHandler("purpose");

export const conversationsRename: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  if (row.is_archived) throw new SlackError("is_archived");
  const name = normalizeChannelName(str(args, "name"));
  const clash = getConversationByName(db, name);
  if (clash && clash.id !== row.id) throw new SlackError("name_taken");
  const from = row.name;

  runMutation(
    db,
    () => renameConversation(db, row.id, name),
    () => ({
      method: httpMethod,
      endpoint: method,
      actionType: "rename",
      targetType: "conversation",
      targetId: row.id,
      request: { channel: row.id, name },
      responseCode: 200,
      summary: `renamed #${from} to #${name}`,
    }),
  );

  const updated = getConversation(db, row.id)!;
  return ok({ channel: shapeConversation(updated, self.userId, isMember(db, row.id, self.userId)) });
};

/**
 * conversations.open — idempotent: returns the existing DM/mpim for the given
 * users, creating one only when absent (`already_open` on repeat, like Slack).
 */
export const conversationsOpen: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const channel = str(args, "channel");
  if (channel) {
    const row = requireChannel(db, channel, self.userId);
    return ok({ already_open: true, channel: { id: row.id } });
  }

  const users = (str(args, "users") ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (!users.length) throw new SlackError("users_not_found");
  for (const u of users) if (!getUser(db, u)) throw new SlackError("user_not_found");

  // Find an existing im/mpim whose member set is exactly {self} ∪ users.
  const want = new Set([self.userId, ...users]);
  const candidates = listConversations(db, {
    types: users.length > 1 ? ["mpim"] : ["im"],
    excludeArchived: false,
    afterId: null,
    limit: 1000,
  });
  for (const c of candidates) {
    const members = db
      .prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?")
      .all(c.id) as Array<{ user_id: string }>;
    const have = new Set(members.map((m) => m.user_id));
    if (have.size === want.size && [...want].every((u) => have.has(u))) {
      return ok({ already_open: true, channel: { id: c.id } });
    }
  }

  const isMpim = users.length > 1;
  const id = runMutation(
    db,
    () => {
      const newIdVal = isMpim ? newGroupId() : newImId();
      const created = Math.floor(Date.now() / 1000);
      insertConversation(db, {
        id: newIdVal,
        isIm: !isMpim,
        isMpim: isMpim,
        isGroup: isMpim,
        isPrivate: true,
        created,
        rawJson: JSON.stringify(
          isMpim
            ? { id: newIdVal, is_mpim: true, is_group: true, is_private: true, created }
            : { id: newIdVal, is_im: true, created, user: users[0] },
        ),
      });
      for (const u of want) addMember(db, newIdVal, u);
      return newIdVal;
    },
    (newIdVal) => ({
      method: httpMethod,
      endpoint: method,
      actionType: "open",
      targetType: "conversation",
      targetId: newIdVal,
      request: { users },
      responseCode: 200,
      summary: `opened ${isMpim ? "group DM" : "DM"} with ${users.join(", ")}`,
    }),
  );

  return ok({ channel: { id }, no_op: false, already_open: false });
};

/** conversations.mark — moves the read cursor; unread counts derive from it. */
export const conversationsMark: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const row = requireChannel(db, str(args, "channel"), self.userId);
  const ts = str(args, "ts");
  if (!ts) throw new SlackError("invalid_timestamp");
  runMutation(
    db,
    () => setLastRead(db, row.id, self.userId, ts),
    () => ({
      method: httpMethod,
      endpoint: method,
      actionType: "mark",
      targetType: "conversation",
      targetId: row.id,
      request: { channel: row.id, ts },
      responseCode: 200,
      summary: `marked ${channelLabel(row)} read up to ${ts}`,
    }),
  );
  return ok({});
};
