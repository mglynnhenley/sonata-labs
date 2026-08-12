import {
  actorLabel,
  created,
  handleLinkedIn,
  json,
  runMutation,
  snippet,
} from "@/lib/linkedin/route-helpers";
import { badRequestError, invalidValueError, missingFieldError } from "@/lib/linkedin/errors";
import { buildPaging, clampCount, nextHref, parseStart } from "@/lib/linkedin/paging";
import { buildCreateInput } from "@/lib/linkedin/post-input";
import { shapePost } from "@/lib/linkedin/shape";
import { shareUrn } from "@/lib/linkedin/urn";
import { insertPost, listPostsByAuthor } from "@/lib/store/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SORT_KEYS = ["LAST_MODIFIED", "CREATED"] as const;

// GET /rest/posts?q=author&author=<urn> — the author finder, and the clone's
// headline read. Descending by the chosen sort key; no paging.total, because
// LinkedIn's posts finder does not return one.
export function GET(req: Request) {
  return handleLinkedIn(req, ({ db }) => {
    const url = new URL(req.url);
    const sp = url.searchParams;
    if (sp.get("q") !== "author") {
      throw badRequestError("Invalid query parameters passed to request");
    }
    const author = sp.get("author");
    if (!author) throw missingFieldError("author");

    const sortBy = sp.get("sortBy") ?? "LAST_MODIFIED";
    if (!(SORT_KEYS as readonly string[]).includes(sortBy)) {
      throw invalidValueError("sortBy", sortBy);
    }
    const start = parseStart(sp.get("start"));
    const count = clampCount(sp.get("count"));

    const page = listPostsByAuthor(db, {
      authorUrn: author,
      sortBy: sortBy as (typeof SORT_KEYS)[number],
      // A DRAFT is the author's own business: READER (the default) never sees
      // one, AUTHOR does. Tombstoned posts are invisible to both.
      includeDrafts: sp.get("viewContext") === "AUTHOR",
      start,
      count,
    });

    return json({
      paging: buildPaging({
        start,
        count,
        hasMore: page.hasMore,
        nextHref: nextHref(url.pathname, sp, start + count),
      }),
      elements: page.rows.map(shapePost),
    });
  });
}

// POST /rest/posts — the clone's headline write.
export function POST(req: Request) {
  return handleLinkedIn(req, async ({ db, ownerMemberId }) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const input = buildCreateInput(body, { db, ownerMemberId, now: Date.now() });

    const row = runMutation(
      db,
      () => insertPost(db, input),
      (post) => ({
        method: "POST",
        endpoint: "/rest/posts",
        actionType: "postCreate",
        targetType: "post",
        targetId: shareUrn(post.id),
        request: body,
        responseCode: 201,
        summary: `Published "${snippet(post.commentary)}" as ${actorLabel(db, post.author_urn)}`,
      }),
    );

    // 201, `x-restli-id`, and an EMPTY body. LinkedIn returns no entity here and
    // every client reads the created id off that header — adding a helpful body
    // would be the one change that makes this clone stop matching.
    return created(shareUrn(row.id));
  });
}
