import {
  actorLabel,
  created,
  handleLinkedIn,
  requireComment,
  requirePublishedPost,
  runMutation,
  snippet,
} from "@/lib/linkedin/route-helpers";
import { requireActor } from "@/lib/linkedin/actor";
import { invalidUrnIdError, invalidValueError, missingFieldError } from "@/lib/linkedin/errors";
import { shapeReaction } from "@/lib/linkedin/shape";
import { canonicalEntityUrn, commentUrn, postIdFromUrn } from "@/lib/linkedin/urn";
import { upsertReaction } from "@/lib/store/reactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /rest/reactions?actor=<urn> — acknowledging engagement.
//
// A reviewer argued this endpoint is a fourth verb the current phase has no
// reader for. It stays because the seed sets up a thread the agent is meant to
// handle, and "handle it" includes acknowledging the comments it is not going to
// answer in full — liking a customer's comment is the cheapest real social
// action there is, and cutting it would leave the clone able to write a reply
// but not to close a loop.
//
// `actor` comes from the QUERY STRING, not the body. That is LinkedIn's own
// shape and it is easy to get wrong from the body-shaped endpoints around it.

const REACTION_TYPES = [
  "LIKE",
  "PRAISE",
  "EMPATHY",
  "INTEREST",
  "APPRECIATION",
  "ENTERTAINMENT",
];

export function POST(req: Request) {
  return handleLinkedIn(req, async ({ db, ownerMemberId }) => {
    const url = new URL(req.url);
    const rawActor = url.searchParams.get("actor");
    if (!rawActor) throw missingFieldError("actor");
    const actor = requireActor(db, rawActor, {
      field: "actor",
      ownerMemberId,
      action: "CREATE /reactions",
    });

    const body = (await req.json().catch(() => ({}))) as {
      root?: unknown;
      reactionType?: unknown;
    };

    const reactionType = body.reactionType;
    if (typeof reactionType !== "string" || !reactionType) throw missingFieldError("reactionType");
    if (!REACTION_TYPES.includes(reactionType)) {
      // MAYBE gets no special case beyond this message: LinkedIn deprecated it
      // in version 202307 and now 400s it, which is exactly what an agent
      // working from an older example will hit.
      throw invalidValueError("reactionType", reactionType);
    }

    if (typeof body.root !== "string" || !body.root) throw missingFieldError("root");
    // A malformed URN is a 400 and a well-formed URN naming nothing is a 404:
    // the distinction is what tells an agent whether to fix its string or to
    // re-read the world.
    const root = canonicalEntityUrn(body.root);
    if (!root) throw invalidUrnIdError();

    const postId = postIdFromUrn(root);
    let entityUrn: string;
    let targetType: "post" | "comment";
    let excerpt: string;
    if (postId) {
      // canonicalEntityUrn has already collapsed share/ugcPost/activity onto the
      // activity spelling, which is what stops one person liking one post twice.
      entityUrn = root;
      targetType = "post";
      excerpt = requirePublishedPost(db, root).commentary;
    } else {
      // The comment half needs the database to finish the job: requireComment
      // refuses a URN whose thread half names the wrong post, and the stored
      // string is rebuilt from the row so it is the same one the readers derive.
      const row = requireComment(db, root);
      entityUrn = commentUrn(row.post_id, row.id);
      targetType = "comment";
      excerpt = row.message_text;
    }

    const now = Date.now();
    const row = runMutation(
      db,
      () =>
        upsertReaction(db, {
          actorUrn: actor.urn,
          entityUrn,
          reactionType,
          createdMs: now,
          isSandboxCreated: true,
        }),
      () => ({
        method: "POST",
        endpoint: "/rest/reactions",
        actionType: "reactionCreate",
        targetType,
        targetId: entityUrn,
        request: { actor: actor.urn, ...body },
        responseCode: 201,
        summary: `Reacted ${reactionType} as ${actorLabel(db, actor.urn)} to "${snippet(excerpt)}"`,
      }),
    );

    // Still a 201 on a repeat: the primary key does the work, and the response
    // describes the reaction that now stands rather than the one that was
    // replaced.
    //
    // The header carries the key of the resource that was CREATED — the compound
    // (actor, entity) reaction URN, which is also the `id` in the body. Sending
    // `row.entity_urn` named the post instead, and every LinkedIn client reads
    // `createdEntityId` off this header, so a caller that liked a post was handed
    // back the post as though it had just made one.
    const resource = shapeReaction(row);
    return created(resource.id, resource);
  });
}
