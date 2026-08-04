import { ok, SlackError } from "../envelope";
import { clampLimit, str } from "../args";
import { decodeCursor, cursorMeta } from "../cursor";
import { listUsers, getUser, shapeUser, countUsers } from "../../store/users";
import type { MethodHandler } from "../route-helpers";

export const usersList: MethodHandler = ({ db, args }) => {
  const limit = clampLimit(args, 100, 1000);
  const afterId = decodeCursor(str(args, "cursor"));
  const rows = listUsers(db, afterId, limit + 1);
  const page = rows.slice(0, limit);
  const nextAnchor = rows.length > limit ? page[page.length - 1].id : null;
  return ok({
    members: page.map(shapeUser),
    cache_ts: 0,
    response_metadata: cursorMeta(nextAnchor),
  });
};

export const usersInfo: MethodHandler = ({ db, args }) => {
  const id = str(args, "user");
  const row = id ? getUser(db, id) : undefined;
  if (!row) throw new SlackError("user_not_found");
  return ok({ user: shapeUser(row) });
};

export const usersCounts: MethodHandler = ({ db }) => {
  // Minimal but well-formed; a few clients ping this for badges.
  return ok({ users: countUsers(db) });
};
