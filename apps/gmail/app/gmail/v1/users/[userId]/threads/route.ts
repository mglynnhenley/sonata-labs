import { handleGmail, json } from "@/lib/gmail/route-helpers";
import { GMAIL_SCOPE } from "@/lib/oauth/scopes";
import { listThreads } from "@/lib/store/threads";
import { compileQuery } from "@/lib/search/compile";
import { clampMaxResults, decodePageToken, encodePageToken } from "@/lib/gmail/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  return handleGmail(req, userId, GMAIL_SCOPE.readonly, ({ db }) => {
    const sp = new URL(req.url).searchParams;
    const limit = clampMaxResults(sp.get("maxResults"));
    const { offset } = decodePageToken(sp.get("pageToken"));
    const labelIds = sp.getAll("labelIds").filter(Boolean);
    const includeSpamTrash = sp.get("includeSpamTrash") === "true";
    const q = sp.get("q") ?? "";
    const search = q ? compileQuery(db, q) : null;

    const result = listThreads(db, { labelIds, includeSpamTrash, search, offset, limit });

    const body: {
      threads?: typeof result.threads;
      nextPageToken?: string;
      resultSizeEstimate: number;
    } = {
      threads: result.threads.length ? result.threads : undefined,
      resultSizeEstimate: result.total,
    };
    if (result.hasMore) body.nextPageToken = encodePageToken({ offset: offset + limit });
    return json(body);
  });
}
