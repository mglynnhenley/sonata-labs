import { ok, SlackError } from "../envelope";
import { str, num } from "../args";
import { searchMessages } from "../../search/compile";
import { getConversation } from "../../store/conversations";
import { getUser } from "../../store/users";
import type { MethodHandler } from "../route-helpers";
import type { SelfIdentity } from "../../store/meta";

export function permalinkFor(self: SelfIdentity, channelId: string, ts: string): string {
  return `https://${self.teamDomain}.slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
}

// search.messages — classic count/page paging (not cursors), newest-first
// (sort=score has no scoring engine here; both sorts return timestamp order).
export const searchMessagesHandler: MethodHandler = ({ db, args, self }) => {
  const query = str(args, "query");
  if (!query) throw new SlackError("invalid_arguments", { detail: "query is required" });
  const count = Math.min(Math.max(num(args, "count") ?? 20, 1), 100);
  const page = Math.max(num(args, "page") ?? 1, 1);

  const { total, matches } = searchMessages(db, query, self.userId, { count, page });
  const pages = Math.max(1, Math.ceil(total / count));

  const shaped = matches.map((m) => {
    const conv = getConversation(db, m.channel_id);
    const user = m.user ? getUser(db, m.user) : undefined;
    return {
      iid: `${m.channel_id}-${m.ts}`,
      team: self.teamId,
      channel: {
        id: m.channel_id,
        name: conv?.name ?? "",
        is_channel: !!conv?.is_channel,
        is_group: !!conv?.is_group,
        is_im: !!conv?.is_im,
        is_mpim: !!conv?.is_mpim,
        is_private: !!conv?.is_private,
      },
      type: "message",
      user: m.user ?? undefined,
      username: user?.name ?? undefined,
      ts: m.ts,
      text: m.text ?? "",
      permalink: permalinkFor(self, m.channel_id, m.ts),
      ...shapeThreadHint(m.thread_ts, m.ts),
    };
  });

  return ok({
    query,
    messages: {
      total,
      pagination: {
        total_count: total,
        page,
        per_page: count,
        page_count: pages,
        first: (page - 1) * count + 1,
        last: Math.min(page * count, total),
      },
      paging: { count, total, page, pages },
      matches: shaped,
    },
  });
};

function shapeThreadHint(threadTs: string | null, ts: string): Record<string, string> {
  if (threadTs && threadTs !== ts) return { thread_ts: threadTs };
  return {};
}
