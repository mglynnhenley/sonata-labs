import { handleGmail, json } from "@/lib/gmail/route-helpers";
import { listMessages } from "@/lib/store/messages";
import { compileQuery } from "@/lib/search/compile";
import { clampMaxResults, decodePageToken, encodePageToken } from "@/lib/gmail/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  return handleGmail(req, userId, ({ db }) => {
    const url = new URL(req.url);
    const sp = url.searchParams;

    const limit = clampMaxResults(sp.get("maxResults"));
    const { offset } = decodePageToken(sp.get("pageToken"));
    const labelIds = sp.getAll("labelIds").filter(Boolean);
    const includeSpamTrash = sp.get("includeSpamTrash") === "true";
    const q = sp.get("q") ?? "";
    const search = q ? compileQuery(db, q) : null;

    const result = listMessages(db, {
      labelIds,
      includeSpamTrash,
      search,
      offset,
      limit,
    });

    const body: {
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
      resultSizeEstimate: number;
    } = {
      // list items are {id, threadId} ONLY — agents rely on list-then-get.
      messages: result.ids.length ? result.ids : undefined,
      resultSizeEstimate: result.total,
    };
    // Omit nextPageToken entirely on the last page (never null).
    if (result.hasMore) {
      body.nextPageToken = encodePageToken({ offset: offset + limit });
    }
    return json(body);
  });
}
