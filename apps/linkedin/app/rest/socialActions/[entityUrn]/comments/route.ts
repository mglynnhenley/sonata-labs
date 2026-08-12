import {
  created,
  handleLinkedIn,
  json,
  requireComment,
  requirePublishedPost,
  runMutation,
  snippet,
} from "@/lib/linkedin/route-helpers";
import { requireActor } from "@/lib/linkedin/actor";
import {
  badRequestError,
  blankFieldError,
  notFoundError,
  unpermittedFieldsError,
} from "@/lib/linkedin/errors";
import { newCommentId } from "@/lib/linkedin/ids";
import { buildPaging, clampCount, nextHref, parseStart } from "@/lib/linkedin/paging";
import { shapeComment, type CommentRow } from "@/lib/linkedin/shape";
import {
  activityUrn,
  commentUrn,
  decodeUrnParam,
  parseCommentUrn,
  postIdFromUrn,
} from "@/lib/linkedin/urn";
import { insertComment, listReplies, listTopLevelComments } from "@/lib/store/comments";
import { reactionsForEntities } from "@/lib/store/reactions";
import type { Database } from "better-sqlite3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ entityUrn: string }> };

// Engagement is not just a number: "who said what, and does any of it need
// answering" is the read that precedes every reply, and answering a customer on
// the company post is the most common real social-manager task after publishing.
//
// The path segment is either a post URN (top-level comments) or a composite
// comment URN (that comment's replies). Both are a single path segment because
// neither contains an unencoded slash.

interface Target {
  postId: string;
  /** Set when the segment named a comment, i.e. we are in the replies of one. */
  parentCommentId: string | null;
  commentsState: string;
}

function resolveTarget(db: Database, urn: string): Target {
  if (parseCommentUrn(urn)) {
    const row = requireComment(db, urn);
    // Published-only, like the post form below: an unpublished post has no
    // thread to read or to answer.
    const post = requirePublishedPost(db, activityUrn(row.post_id));
    return { postId: row.post_id, parentCommentId: row.id, commentsState: post.comments_state };
  }
  if (postIdFromUrn(urn)) {
    const post = requirePublishedPost(db, urn);
    return { postId: post.id, parentCommentId: null, commentsState: post.comments_state };
  }
  throw notFoundError("The requested entity was not found.");
}

/**
 * The comment a reply is aimed at. LinkedIn documents TWO spellings and an agent
 * working from the samples will send either: the parent's URN as the path
 * segment, or `parentComment` in the body of a POST addressed to the post
 * itself. Ignoring the body field is the worst of the three options — the reply
 * lands at the top of the thread, the 201 says nothing is wrong, and the judge
 * scores a top-level comment where the task was to answer one specific customer.
 */
function resolveParent(db: Database, raw: unknown, target: Target): string | null {
  if (raw === undefined) return target.parentCommentId;
  const urn = typeof raw === "string" ? raw : "";
  if (!parseCommentUrn(urn)) {
    throw badRequestError(`parentComment ${JSON.stringify(raw)} is not a comment URN.`);
  }
  const parent = requireComment(db, urn);
  // Same rule the `object` field gets: a disagreement with the URL means the
  // caller is confused about what it is answering, and quietly preferring one
  // of the two would hide it.
  const disagrees =
    parent.post_id !== target.postId ||
    (target.parentCommentId !== null && target.parentCommentId !== parent.id);
  if (disagrees) {
    throw badRequestError(
      `parentComment ${JSON.stringify(raw)} does not match the entity in the request path.`,
    );
  }
  return parent.id;
}

export function GET(req: Request, { params }: Ctx) {
  return handleLinkedIn(req, async ({ db, ownerPersonUrn }) => {
    const { entityUrn } = await params;
    const target = resolveTarget(db, decodeUrnParam(entityUrn));
    const url = new URL(req.url);
    const start = parseStart(url.searchParams.get("start"));
    const count = clampCount(url.searchParams.get("count"));

    const page =
      target.parentCommentId === null
        ? listTopLevelComments(db, target.postId, { start, count })
        : listReplies(db, target.parentCommentId, { start, count });

    // LinkedIn documents this verbatim: "If no comments or likes are available
    // for a share, a request to fetch comments or shares returns 404 - Not
    // Found." It is why the docs tell you to read socialMetadata first — that is
    // the call that distinguishes "no comments" from "no such post", and an
    // agent has to meet the same shape here that it would there.
    if (page.total === 0) throw notFoundError("The requested entity was not found.");

    // One query for every comment's likes rather than one per row: a ten-comment
    // thread should not be eleven round trips to SQLite.
    const likesByUrn = reactionsForEntities(
      db,
      page.rows.map((row) => commentUrn(row.post_id, row.id)),
    );

    return json({
      elements: page.rows.map((row: CommentRow) =>
        shapeComment(row, {
          likes: likesByUrn.get(commentUrn(row.post_id, row.id)) ?? [],
          ownerUrn: ownerPersonUrn,
        }),
      ),
      paging: buildPaging({
        start,
        count,
        hasMore: start + page.rows.length < page.total,
        // Unlike the posts finder, LinkedIn's comments finder DOES return a
        // total — an agent uses it to decide whether a thread is worth reading
        // in full before it pages through one.
        total: page.total,
        nextHref: nextHref(url.pathname, url.searchParams, start + count),
      }),
    });
  });
}

export function POST(req: Request, { params }: Ctx) {
  return handleLinkedIn(req, async ({ db, ownerMemberId }) => {
    const { entityUrn } = await params;
    const targetUrn = decodeUrnParam(entityUrn);
    const target = resolveTarget(db, targetUrn);

    const body = (await req.json().catch(() => ({}))) as {
      actor?: unknown;
      object?: unknown;
      parentComment?: unknown;
      content?: unknown;
      message?: { text?: unknown; attributes?: unknown };
    };

    // LinkedIn's real refusal of inline comment images, reproduced verbatim
    // because an agent that tries to attach one has to see the vendor's answer
    // rather than a silently-dropped field.
    if (body.content !== undefined) throw unpermittedFieldsError(["/content"]);

    const actor = requireActor(db, body.actor, {
      field: "actor",
      ownerMemberId,
      action: "CREATE /socialActions/comments",
    });

    const text = body.message?.text;
    if (typeof text !== "string") throw blankFieldError("message.text");
    if (!text.trim()) throw blankFieldError("message.text");

    // `object` is optional, but when present it has to name the thread the URL
    // already named — a disagreement means the caller is confused about which
    // post they are answering, and quietly using the URL would hide it.
    if (body.object !== undefined) {
      const objectId = typeof body.object === "string" ? postIdFromUrn(body.object) : null;
      if (objectId !== target.postId) {
        throw badRequestError(
          `object ${JSON.stringify(body.object)} does not match the entity in the request path.`,
        );
      }
    }

    const parentCommentId = resolveParent(db, body.parentComment, target);

    if (target.commentsState === "CLOSED") {
      throw badRequestError("Comments are disabled on this post.", "COMMENTS_DISABLED");
    }

    const now = Date.now();
    const row = runMutation(
      db,
      () =>
        insertComment(db, {
          id: newCommentId(now),
          postId: target.postId,
          parentCommentId,
          actorUrn: actor.urn,
          agentUrn: actor.agentUrn,
          text,
          attributes: Array.isArray(body.message?.attributes) ? body.message.attributes : null,
          createdMs: now,
          isSandboxCreated: true,
        }),
      (comment) => ({
        method: "POST",
        endpoint: `/rest/socialActions/${targetUrn}/comments`,
        actionType: "commentCreate",
        targetType: "comment",
        targetId: commentUrn(comment.post_id, comment.id),
        request: body,
        responseCode: 201,
        // A reply names what it answers. The parent can now arrive in the body
        // rather than in the URL, and "answered the customer nobody answered" is
        // exactly the distinction the judge is looking for in this line.
        summary: comment.parent_comment_id
          ? `Replied to ${commentUrn(comment.post_id, comment.parent_comment_id)}: ` +
            `"${snippet(comment.message_text)}"`
          : `Commented on ${activityUrn(comment.post_id)}: "${snippet(comment.message_text)}"`,
      }),
    );

    // 201 with the BARE comment id in x-restli-id — not a URN, unlike a post
    // create — and a full body. Both halves of that asymmetry are what LinkedIn
    // does, and a client depends on the difference.
    return created(row.id, shapeComment(row, { ownerUrn: `urn:li:person:${ownerMemberId}` }));
  });
}
