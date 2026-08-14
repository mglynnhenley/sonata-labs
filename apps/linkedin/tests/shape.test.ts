import { describe, it, expect } from "vitest";
import {
  CORPUS,
  COMMENT_JORDAN,
  COMMENT_PAGE_REPLY,
  DAN_URN,
  JORDAN_URN,
  makeTestDb,
  ORG_URN,
  OWNER_URN,
  POST_BUSY,
  POST_DRAFT,
  PRIYA_URN,
  at,
} from "./helpers";
import {
  shapeAcl,
  shapeComment,
  shapeOrganization,
  shapePost,
  shapeReaction,
  shapeSocialMetadata,
  shapeUserInfo,
  type CommentRow,
  type PostRow,
} from "@/lib/linkedin/shape";
import {
  accessDeniedError,
  invalidUrnIdError,
  emptyToken,
  toErrorResponse,
  unpermittedFieldsError,
  type LinkedInErrorBody,
} from "@/lib/linkedin/errors";
import { activityUrn, commentUrn, shareUrn } from "@/lib/linkedin/urn";
import { getCommentRow } from "@/lib/store/comments";
import { getPostRow } from "@/lib/store/posts";
import { reactionsForEntities } from "@/lib/store/reactions";
import { getOwnerMember } from "@/lib/store/members";
import { getOrganization } from "@/lib/store/organizations";

// Fidelity of the resources and of the error envelope — the two things a
// caller's client library reads directly.

function post(id: string): PostRow {
  const db = makeTestDb(CORPUS);
  const row = getPostRow(db, id);
  if (!row) throw new Error(`no fixture post ${id}`);
  return row;
}

function comment(id: string): { row: CommentRow; db: ReturnType<typeof makeTestDb> } {
  const db = makeTestDb(CORPUS);
  const row = getCommentRow(db, id);
  if (!row) throw new Error(`no fixture comment ${id}`);
  return { row, db };
}

describe("shapePost", () => {
  it("names the post by its SHARE urn while references elsewhere use ACTIVITY", () => {
    const shaped = shapePost(post(POST_BUSY));
    expect(shaped.id).toBe(shareUrn(POST_BUSY));
    const { row } = comment(COMMENT_JORDAN);
    expect(shapeComment(row, { ownerUrn: OWNER_URN }).object).toBe(activityUrn(POST_BUSY));
  });

  it("emits the three timestamps as NUMBERS", () => {
    // The trap: every other clone in this repo emits ISO strings, and an agent
    // parsing these as dates has to find a number here or it silently gets 1970.
    const shaped = shapePost(post(POST_BUSY));
    expect(typeof shaped.createdAt).toBe("number");
    expect(typeof shaped.lastModifiedAt).toBe("number");
    expect(typeof shaped.publishedAt).toBe("number");
  });

  it("omits publishedAt entirely on a DRAFT", () => {
    const shaped = shapePost(post(POST_DRAFT));
    expect("publishedAt" in shaped).toBe(false);
    expect(shaped.lifecycleState).toBe("DRAFT");
  });

  it("follows is_edited into lifecycleStateInfo", () => {
    const row = post(POST_BUSY);
    expect(shapePost(row).lifecycleStateInfo.isEditedByAuthor).toBe(false);
    expect(shapePost({ ...row, is_edited: 1 }).lifecycleStateInfo.isEditedByAuthor).toBe(true);
  });

  it("returns distribution without targetEntities", () => {
    // targetEntities is a create-request field; every documented read sample
    // carries feedDistribution and thirdPartyDistributionChannels only.
    const shaped = shapePost(post(POST_BUSY));
    expect(shaped.distribution).toEqual({
      feedDistribution: "MAIN_FEED",
      thirdPartyDistributionChannels: [],
    });
  });

  it("emits an empty content object on a text-only post", () => {
    expect(shapePost(post(POST_BUSY)).content).toEqual({});
  });

  it("round-trips the passthrough keys and only those", () => {
    const db = makeTestDb([
      {
        id: "7488000000000000001",
        commentary: "with content",
        createdMs: at(0, 9),
        extra: {
          content: { article: { source: "https://example.com" } },
          contentCallToActionLabel: "LEARN_MORE",
          contentLandingPage: "https://example.com",
        },
      },
    ]);
    const shaped = shapePost(getPostRow(db, "7488000000000000001")!);
    expect(shaped.content).toEqual({ article: { source: "https://example.com" } });
    expect(shaped.contentCallToActionLabel).toBe("LEARN_MORE");
    expect(shaped.contentLandingPage).toBe("https://example.com");
  });

  it("survives a raw_json blob that got mangled", () => {
    const row = { ...post(POST_BUSY), raw_json: "{not json" };
    expect(() => shapePost(row)).not.toThrow();
    expect(shapePost(row).content).toEqual({});
  });
});

describe("shapeComment", () => {
  it("builds a commentUrn consistent with object + id", () => {
    const { row } = comment(COMMENT_JORDAN);
    const shaped = shapeComment(row, { ownerUrn: OWNER_URN });
    expect(shaped.commentUrn).toBe(commentUrn(POST_BUSY, COMMENT_JORDAN));
    expect(shaped.commentUrn).toBe(`urn:li:comment:(${shaped.object},${shaped.id})`);
  });

  it("defaults message.attributes to an empty array", () => {
    const { row } = comment(COMMENT_JORDAN);
    expect(shapeComment(row, { ownerUrn: OWNER_URN }).message.attributes).toEqual([]);
  });

  it("carries parentComment only on a reply", () => {
    const { row: top } = comment(COMMENT_JORDAN);
    const { row: reply } = comment(COMMENT_PAGE_REPLY);
    expect("parentComment" in shapeComment(top, { ownerUrn: OWNER_URN })).toBe(false);
    expect(shapeComment(reply, { ownerUrn: OWNER_URN }).parentComment).toBe(
      commentUrn(POST_BUSY, COMMENT_JORDAN),
    );
  });

  it("records the admin behind a page's comment", () => {
    // The clone's headline write is replying AS the company page, so this is the
    // exact artifact an agent produces and it has to carry `agent` and the
    // impersonator inside both stamps.
    const { row } = comment(COMMENT_PAGE_REPLY);
    const shaped = shapeComment(row, { ownerUrn: OWNER_URN });
    expect(shaped.actor).toBe(ORG_URN);
    expect(shaped.agent).toBe(OWNER_URN);
    expect(shaped.created).toEqual({ actor: ORG_URN, impersonator: OWNER_URN, time: at(1, 10, 58) });
  });

  it("leaves impersonator off a person's comment", () => {
    const { row } = comment(COMMENT_JORDAN);
    const shaped = shapeComment(row, { ownerUrn: OWNER_URN });
    expect("agent" in shaped).toBe(false);
    expect(shaped.created).toEqual({ actor: JORDAN_URN, time: at(1, 10, 3) });
  });

  it("counts likes, flags the current user, and caps the preview at three", () => {
    const { row, db } = comment(COMMENT_JORDAN);
    const likes = reactionsForEntities(db, [commentUrn(POST_BUSY, COMMENT_JORDAN)]).get(
      commentUrn(POST_BUSY, COMMENT_JORDAN),
    )!;
    const shaped = shapeComment(row, { likes, ownerUrn: OWNER_URN });
    expect(shaped.likesSummary?.totalLikes).toBe(4);
    expect(shaped.likesSummary?.aggregatedTotalLikes).toBe(4);
    expect(shaped.likesSummary?.likedByCurrentUser).toBe(true);
    expect(shaped.likesSummary?.selectedLikes).toHaveLength(3);
    expect(shaped.likesSummary?.selectedLikes[0]).toContain("urn:li:like:(");
  });

  it("omits likesSummary entirely when no likes were fetched", () => {
    // A create response carries none: LinkedIn returns likesSummary from reads
    // only, and a brand-new comment trivially has none.
    const { row } = comment(COMMENT_JORDAN);
    expect("likesSummary" in shapeComment(row, { ownerUrn: OWNER_URN })).toBe(false);
  });

  it("reports likedByCurrentUser false when the owner did not like it", () => {
    const { row, db } = comment(COMMENT_PAGE_REPLY);
    const likes =
      reactionsForEntities(db, [commentUrn(POST_BUSY, COMMENT_PAGE_REPLY)]).get(
        commentUrn(POST_BUSY, COMMENT_PAGE_REPLY),
      ) ?? [];
    expect(shapeComment(row, { likes, ownerUrn: OWNER_URN }).likesSummary?.likedByCurrentUser).toBe(
      false,
    );
  });
});

describe("shapeSocialMetadata", () => {
  it("drops every reaction type with a zero count", () => {
    const shaped = shapeSocialMetadata({
      entityUrn: activityUrn(POST_BUSY),
      commentsState: "OPEN",
      count: 2,
      topLevelCount: 1,
      reactionCounts: { LIKE: 2, PRAISE: 1, EMPATHY: 0 },
    });
    expect(Object.keys(shaped.reactionSummaries)).toEqual(["LIKE", "PRAISE"]);
    expect(shaped.reactionSummaries.LIKE).toEqual({ reactionType: "LIKE", count: 2 });
  });

  it("counts replies in count but not in topLevelCount", () => {
    const shaped = shapeSocialMetadata({
      entityUrn: activityUrn(POST_BUSY),
      commentsState: "OPEN",
      count: 2,
      topLevelCount: 1,
      reactionCounts: {},
    });
    expect(shaped.commentSummary).toEqual({ count: 2, topLevelCount: 1 });
  });
});

describe("the identity and organization shapes", () => {
  it("hands back a BARE person id in sub", () => {
    const db = makeTestDb();
    const shaped = shapeUserInfo(getOwnerMember(db)!);
    expect(shaped.sub).toBe("sHq2WpRk9L");
    expect(shaped.sub).not.toContain("urn:");
    expect(shaped.locale).toBe("en-US");
    expect(shaped.email_verified).toBe(true);
  });

  it("returns the organization id as a NUMBER alongside its URN", () => {
    const db = makeTestDb();
    const shaped = shapeOrganization(getOrganization(db, "7412903")!);
    expect(shaped.id).toBe(7412903);
    expect(shaped.$URN).toBe(ORG_URN);
    expect(shaped.localizedName).toBe("Acme");
    expect(shaped.name.localized.en_US).toBe("Acme");
  });

  it("emits both organization spellings on an ACL element", () => {
    const shaped = shapeAcl({
      organization_id: "7412903",
      member_id: "sHq2WpRk9L",
      role: "ADMINISTRATOR",
      state: "APPROVED",
    });
    expect(shaped.organization).toBe(ORG_URN);
    expect(shaped.organizationTarget).toBe(ORG_URN);
    expect(shaped.roleAssignee).toBe(OWNER_URN);
  });

  it("shapes a reaction into its composite id", () => {
    const shaped = shapeReaction({
      actor_urn: PRIYA_URN,
      entity_urn: activityUrn(POST_BUSY),
      reaction_type: "PRAISE",
      created_ms: at(1, 9),
      last_modified_ms: at(1, 10),
      is_sandbox_created: 1,
    });
    expect(shaped.id).toBe(`urn:li:reaction:(${PRIYA_URN},${activityUrn(POST_BUSY)})`);
    expect(shaped.root).toBe(activityUrn(POST_BUSY));
    expect(shaped.lastModified.time).toBe(at(1, 10));
  });
});

describe("the error envelope", () => {
  async function bodyOf(err: unknown): Promise<LinkedInErrorBody> {
    return (await toErrorResponse(err).json()) as LinkedInErrorBody;
  }

  it("is flat, with no nesting", async () => {
    const body = await bodyOf(invalidUrnIdError());
    expect(body).toEqual({
      status: 400,
      serviceErrorCode: 0,
      code: "INVALID_URN_ID",
      message: "The URN ID provided is invalid.",
    });
  });

  it("reproduces the unpermitted-fields wording verbatim", async () => {
    const body = await bodyOf(unpermittedFieldsError(["/patch/$set/visibility"]));
    expect(body.status).toBe(403);
    expect(body.serviceErrorCode).toBe(100);
    expect(body.message).toBe(
      "Unpermitted fields present in REQUEST_BODY: Data Processing Exception while " +
        "processing fields [/patch/$set/visibility]",
    );
  });

  it("keeps LinkedIn's own 401 wording and service error code", async () => {
    const body = (await emptyToken().json()) as LinkedInErrorBody;
    expect(body).toEqual({ status: 401, serviceErrorCode: 401, message: "Empty oauth2_access_token" });
  });

  it("turns an unknown throw into a 500 rather than leaking a stack", async () => {
    const body = await bodyOf(new TypeError("x is not a function"));
    expect(body.status).toBe(500);
    expect(body.code).toBe("INTERNAL_SERVER_ERROR");
    expect(body.message).toBe("x is not a function");
  });

  it("carries a 403 through with its service error code", async () => {
    const body = await bodyOf(accessDeniedError("nope"));
    expect(body).toEqual({ status: 403, serviceErrorCode: 100, code: "ACCESS_DENIED", message: "nope" });
  });
});

describe("fixture sanity", () => {
  it("keeps Dan out of the busy post's comment thread", () => {
    // Guards the helpers themselves: several assertions above are only meaningful
    // because exactly one person commented at the top level.
    const db = makeTestDb(CORPUS);
    expect(getCommentRow(db, COMMENT_JORDAN)?.actor_urn).not.toBe(DAN_URN);
  });
});
