import {
  handleLinkedIn,
  json,
  requireComment,
  requirePublishedPost,
} from "@/lib/linkedin/route-helpers";
import { notFoundError } from "@/lib/linkedin/errors";
import { shapeSocialMetadata } from "@/lib/linkedin/shape";
import { activityUrn, commentUrn, decodeUrnParam, parseCommentUrn, postIdFromUrn } from "@/lib/linkedin/urn";
import { countCommentsForPost, countReplies } from "@/lib/store/comments";
import { reactionCountsByType } from "@/lib/store/reactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ entityUrn: string }> };

// "Check the engagement on a post", in one call — this single endpoint is what
// that task resolves to, which is why it is worth a route of its own rather than
// being folded into the post resource. LinkedIn keeps them separate, and an
// agent that expects the counts on the post itself has to find them missing here
// too.
//
// It is also the call that tells "this post has no comments" from "there is no
// such post", because the comments finder answers 404 for both.
export function GET(req: Request, { params }: Ctx) {
  return handleLinkedIn(req, async ({ db }) => {
    const { entityUrn } = await params;
    const raw = decodeUrnParam(entityUrn);

    if (parseCommentUrn(raw)) {
      // Resolved through requireComment, so a URN naming the right comment on
      // the wrong thread is the same 404 here as it is on the write paths — a
      // near miss that read back fine would tell an agent its spelling works.
      const row = requireComment(db, raw);
      const self = commentUrn(row.post_id, row.id);
      const replies = countReplies(db, row.id);
      return json(
        shapeSocialMetadata({
          // Echoed verbatim for a comment — only a post gets rewritten.
          entityUrn: self,
          commentsState: requirePublishedPost(db, activityUrn(row.post_id)).comments_state,
          count: replies,
          topLevelCount: replies,
          reactionCounts: reactionCountsByType(db, self),
        }),
      );
    }

    if (!postIdFromUrn(raw)) throw notFoundError("The requested entity was not found.");
    // Published-only: engagement on an unpublished post is a state that cannot
    // exist, so answering 200 here would leak the draft and its activity URN to
    // a reader the posts endpoint has just told there is no such post.
    const post = requirePublishedPost(db, raw);
    const self = activityUrn(post.id);
    const counts = countCommentsForPost(db, post.id);
    return json(
      shapeSocialMetadata({
        // Always the ACTIVITY urn, which is what the real API returns even when
        // you asked by share URN — and the reason urn.ts canonicalises.
        entityUrn: self,
        commentsState: post.comments_state,
        count: counts.count,
        topLevelCount: counts.topLevelCount,
        reactionCounts: reactionCountsByType(db, self),
      }),
    );
  });
}
