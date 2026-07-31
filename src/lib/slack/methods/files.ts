import { ok, SlackError } from "../envelope";
import { str, num } from "../args";
import { listFiles, getFile, shapeFile } from "../../store/files";
import type { MethodHandler } from "../route-helpers";

// files.list uses classic page/count paging (not cursors) — one of Slack's
// older corners the SDK still models.
export const filesList: MethodHandler = ({ db, args }) => {
  const count = Math.min(num(args, "count") ?? 100, 1000);
  const page = Math.max(num(args, "page") ?? 1, 1);
  const { rows, total } = listFiles(db, {
    channelId: str(args, "channel") ?? null,
    userId: str(args, "user") ?? null,
    limit: count,
    offset: (page - 1) * count,
  });
  return ok({
    files: rows.map((f) => shapeFile(db, f)),
    paging: {
      count,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / count)),
    },
  });
};

export const filesInfo: MethodHandler = ({ db, args }) => {
  const id = str(args, "file");
  const row = id ? getFile(db, id) : undefined;
  if (!row) throw new SlackError("file_not_found");
  return ok({
    file: shapeFile(db, row),
    comments: [],
    response_metadata: { next_cursor: "" },
  });
};
