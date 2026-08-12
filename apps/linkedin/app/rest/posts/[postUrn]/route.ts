import {
  handleLinkedIn,
  json,
  noContent,
  requirePost,
  restliMethod,
  runMutation,
  snippet,
} from "@/lib/linkedin/route-helpers";
import { requirePostAuthor } from "@/lib/linkedin/actor";
import { badRequestError, notFoundError } from "@/lib/linkedin/errors";
import { buildPatchInput } from "@/lib/linkedin/post-input";
import { shapePost } from "@/lib/linkedin/shape";
import { decodeUrnParam, postIdFromUrn, shareUrn } from "@/lib/linkedin/urn";
import { getPostRow, tombstonePost, updatePost } from "@/lib/store/posts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ postUrn: string }> };

// One post, addressed by URN. `urn:li:share:N`, `urn:li:ugcPost:N` and
// `urn:li:activity:N` all resolve here, which is what lets an agent take the
// `object` URN off a comment and read the post with it.

export function GET(req: Request, { params }: Ctx) {
  return handleLinkedIn(req, async ({ db }) => {
    const { postUrn } = await params;
    const row = requirePost(db, decodeUrnParam(postUrn));
    // A DRAFT is invisible to a reader — same 404 as a post that never existed,
    // which is the whole point of an unpublished post.
    if (row.lifecycle_state === "DRAFT" && new URL(req.url).searchParams.get("viewContext") !== "AUTHOR") {
      throw notFoundError("The requested post was not found.");
    }
    return json(shapePost(row));
  });
}

// POST /rest/posts/{urn} with X-RestLi-Method: PARTIAL_UPDATE — fix a typo, or
// publish the draft. LinkedIn's real publish-a-draft move is a lifecycleState
// patch, not a second create.
export function POST(req: Request, { params }: Ctx) {
  return handleLinkedIn(req, async ({ db, ownerMemberId }) => {
    const { postUrn } = await params;
    const row = requirePost(db, decodeUrnParam(postUrn));

    // An ABSENT header is accepted and read as the patch: the header is how
    // Rest.li disambiguates a POST to an entity URL, clients always send it, and
    // the patch is the only thing this clone does at this path — real LinkedIn
    // also overloads it for query-tunnelled GET, which is out of scope here. A
    // PRESENT header naming anything else means the caller believes they are
    // doing something this route will not do, and that has to be loud.
    const method = restliMethod(req);
    if (method !== null && method !== "PARTIAL_UPDATE") {
      throw badRequestError(
        `X-RestLi-Method ${method} is not supported on /rest/posts/{postUrn}; use PARTIAL_UPDATE.`,
      );
    }

    // Editing is scoped to the post's author, not to anyone holding the URN —
    // the gate reads the author off the row rather than off the request, because
    // an edit names no actor at all.
    requirePostAuthor(db, row.author_urn, { ownerMemberId, action: "PARTIAL_UPDATE /posts" });

    const body = (await req.json().catch(() => ({}))) as { patch?: unknown };
    const { patch, publishesDraft } = buildPatchInput(body.patch, row, Date.now());

    runMutation(
      db,
      () => updatePost(db, row.id, patch),
      (updated) => ({
        method: "POST",
        endpoint: `/rest/posts/${shareUrn(row.id)}`,
        // Publishing the draft the CEO left is a different act from fixing a
        // typo, and the judge has to be able to tell them apart in the trail.
        actionType: publishesDraft ? "postPublish" : "postUpdate",
        targetType: "post",
        targetId: shareUrn(updated.id),
        request: body,
        responseCode: 204,
        summary: publishesDraft
          ? `Published the draft "${snippet(updated.commentary)}"`
          : `Edited the post "${snippet(updated.commentary)}"`,
      }),
    );

    return noContent();
  });
}

export function DELETE(req: Request, { params }: Ctx) {
  return handleLinkedIn(req, async ({ db, ownerMemberId }) => {
    const { postUrn } = await params;
    // Resolved through getPostRow, NOT requirePost: post deletion is idempotent
    // at LinkedIn — a second DELETE of the same post is another 204, never a 410
    // (deliberately unlike the Calendar clone) — and a tombstoned row has to
    // still be findable for that to be true.
    const id = postIdFromUrn(decodeUrnParam(postUrn));
    const row = id ? getPostRow(db, id) : null;
    if (!row) throw notFoundError("The requested post was not found.");

    // Gated before the idempotence branch: deleting a post that is not the
    // caller's has to be a 403 the second time as well, or the refusal reads as
    // "already gone" and an agent learns it succeeded.
    requirePostAuthor(db, row.author_urn, { ownerMemberId, action: "DELETE /posts" });

    if (row.deleted_ms === null) {
      runMutation(
        db,
        () => tombstonePost(db, row.id, Date.now()),
        () => ({
          method: "DELETE",
          endpoint: `/rest/posts/${shareUrn(row.id)}`,
          actionType: "postDelete",
          targetType: "post",
          targetId: shareUrn(row.id),
          responseCode: 204,
          summary: `Deleted "${snippet(row.commentary)}"`,
        }),
      );
    }
    // The repeat writes no audit row: a second no-op that logged would tell the
    // judge the agent destroyed two things.
    return noContent();
  });
}
