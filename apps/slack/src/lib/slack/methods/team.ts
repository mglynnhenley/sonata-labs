import { ok, SlackError } from "../envelope";
import { str, clampLimit } from "../args";
import { decodeCursor, cursorMeta } from "../cursor";
import { listConversations, isMember, shapeConversation } from "../../store/conversations";
import { getUser, listUsers, shapeUser } from "../../store/users";
import { EMOJI_NAMES } from "../emoji-names";
import type { MethodHandler } from "../route-helpers";

export const teamInfo: MethodHandler = ({ self }) =>
  ok({
    team: {
      id: self.teamId,
      name: self.teamName,
      domain: self.teamDomain,
      email_domain: "",
      icon: {
        image_34: `https://sandbox.local/team/${self.teamId}_34.png`,
        image_88: `https://sandbox.local/team/${self.teamId}_88.png`,
        image_default: true,
      },
    },
  });

/**
 * users.conversations — the conversations a user belongs to. Commonly the
 * first call an agent makes ("what can I see?"), so worth serving properly
 * rather than making agents filter conversations.list themselves.
 */
export const usersConversations: MethodHandler = ({ db, args, self }) => {
  const userId = str(args, "user") ?? self.userId;
  const types = (str(args, "types") ?? "public_channel").split(",").map((t) => t.trim());
  const excludeArchived = (str(args, "exclude_archived") ?? "false") === "true";
  const limit = clampLimit(args, 100, 1000);
  const afterId = decodeCursor(str(args, "cursor"));

  const all = listConversations(db, { types, excludeArchived, afterId, limit: 1000 }).filter(
    (c) =>
      isMember(db, c.id, userId) &&
      // Never leak a private conversation the CALLER isn't in, even when
      // asking about somebody else.
      (!c.is_private || isMember(db, c.id, self.userId)),
  );
  const page = all.slice(0, limit);
  const nextAnchor = all.length > limit ? page[page.length - 1].id : null;
  return ok({
    channels: page.map((c) => shapeConversation(c, self.userId, true)),
    response_metadata: cursorMeta(nextAnchor),
  });
};

export const usersLookupByEmail: MethodHandler = ({ db, args }) => {
  const email = (str(args, "email") ?? "").toLowerCase();
  if (!email) throw new SlackError("invalid_email");
  for (const row of listUsers(db, null, 1000)) {
    const shaped = shapeUser(row);
    const candidate =
      (shaped.profile?.email as string | undefined)?.toLowerCase() ??
      // The seed has no emails; fall back to the conventional handle@domain.
      `${row.name}@sandbox.local`;
    if (candidate === email) return ok({ user: shaped });
  }
  throw new SlackError("users_not_found");
};

// Presence is in-memory: it is session state, not workspace data, so it should
// not survive a reset the way DB-backed things do.
const g = globalThis as unknown as { __slackSandboxPresence?: Map<string, string> };
if (!g.__slackSandboxPresence) g.__slackSandboxPresence = new Map();
const presence = g.__slackSandboxPresence;

export const usersSetPresence: MethodHandler = ({ args, self }) => {
  const value = str(args, "presence");
  if (value !== "auto" && value !== "away") throw new SlackError("invalid_presence");
  presence.set(self.userId, value);
  return ok({});
};

export const usersGetPresence: MethodHandler = ({ db, args, self }) => {
  const userId = str(args, "user") ?? self.userId;
  const row = getUser(db, userId);
  if (!row) throw new SlackError("user_not_found");
  const set = presence.get(userId) ?? "auto";
  // Bots read as active; humans follow whatever was set.
  const active = row.is_bot ? true : set === "auto";
  return ok({
    presence: active ? "active" : "away",
    online: active,
    auto_away: false,
    manual_away: set === "away",
    connection_count: active ? 1 : 0,
  });
};

export const emojiList: MethodHandler = ({ self }) =>
  ok({
    emoji: Object.fromEntries(
      EMOJI_NAMES.map((n) => [n, `https://sandbox.local/emoji/${n}.png`]),
    ),
    cache_ts: String(Math.floor(Date.now() / 1000)),
    categories_version: "1",
    // Slack includes the team so clients can namespace custom emoji.
    team_id: self.teamId,
  });
