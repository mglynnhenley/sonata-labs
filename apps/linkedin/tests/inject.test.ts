import { describe, it, expect } from "vitest";
import {
  COMMENT_JORDAN,
  CORPUS,
  makeTestDb,
  POST_BUSY,
  POST_DRAFT,
  POST_QUIET,
  PRIYA_URN,
} from "./helpers";
import { injectComment, injectReaction } from "@/lib/sandbox/inject";
import { BadRequestError } from "@/lib/sandbox/auth";
import { activityUrn, commentUrn, shareUrn } from "@/lib/linkedin/urn";
import { reactionCountsByType } from "@/lib/store/reactions";

// The director's beats, from the side that matters: a beat that writes a row no
// agent can see is worse than a beat that fails, because the scenario reports
// success and the world never changed. Everything here is about refusing that.

const AT = { atISO: "2026-07-28T11:00:00Z" };

describe("injectReaction", () => {
  it("stores a post reaction under the activity URN, whatever spelling asked", () => {
    const db = makeTestDb(CORPUS);
    for (const [urn, actorEmail] of [
      [shareUrn(POST_QUIET), "priya@acme.co"],
      [activityUrn(POST_QUIET), "dan@acme.co"],
    ] as const) {
      const injected = injectReaction(db, { entityUrn: urn, actorEmail, ...AT });
      expect(injected.entityUrn).toBe(activityUrn(POST_QUIET));
    }
    expect(reactionCountsByType(db, activityUrn(POST_QUIET))).toEqual({ LIKE: 2 });
  });

  it("stores a comment reaction under the URN the readers rebuild", () => {
    const db = makeTestDb(CORPUS);
    const injected = injectReaction(db, {
      entityUrn: commentUrn(POST_BUSY, COMMENT_JORDAN),
      actorEmail: "mei@acme.co",
      reactionType: "PRAISE",
      ...AT,
    });
    expect(injected.entityUrn).toBe(commentUrn(POST_BUSY, COMMENT_JORDAN));
    expect(reactionCountsByType(db, commentUrn(POST_BUSY, COMMENT_JORDAN)).PRAISE).toBe(1);
  });

  it("refuses a comment URN whose thread half names another post", () => {
    // Silently accepting this is the beat that writes a row socialMetadata and
    // likesSummary can never see — so the message names the post the comment is
    // really on, which is the fix the director needs.
    const db = makeTestDb(CORPUS);
    expect(() =>
      injectReaction(db, {
        entityUrn: commentUrn(POST_QUIET, COMMENT_JORDAN),
        actorEmail: "priya@acme.co",
        ...AT,
      }),
    ).toThrow(new RegExp(`lives on ${activityUrn(POST_BUSY)}`));
    expect(reactionCountsByType(db, commentUrn(POST_QUIET, COMMENT_JORDAN))).toEqual({});
  });

  it("refuses a reactor the world has never heard of", () => {
    const db = makeTestDb(CORPUS);
    expect(() =>
      injectReaction(db, {
        entityUrn: activityUrn(POST_BUSY),
        actorEmail: "stranger@example.com",
        ...AT,
      }),
    ).toThrow(BadRequestError);
  });

  it("refuses to engage with a post nobody published", () => {
    const db = makeTestDb(CORPUS);
    expect(() =>
      injectReaction(db, { entityUrn: shareUrn(POST_DRAFT), actorEmail: "priya@acme.co", ...AT }),
    ).toThrow(/DRAFT/);
    expect(() =>
      injectComment(db, {
        postUrn: shareUrn(POST_DRAFT),
        actorEmail: "priya@acme.co",
        text: "on an unpublished post",
        ...AT,
      }),
    ).toThrow(/DRAFT/);
  });
});

describe("injectComment", () => {
  it("threads a reply onto its parent and names both URNs back", () => {
    const db = makeTestDb(CORPUS);
    const injected = injectComment(db, {
      parentCommentUrn: commentUrn(POST_BUSY, COMMENT_JORDAN),
      actorEmail: "priya@acme.co",
      text: "Following up on this.",
      ...AT,
    });
    expect(injected.postUrn).toBe(shareUrn(POST_BUSY));
    expect(injected.commentUrn).toBe(commentUrn(POST_BUSY, injected.id));
    const row = db
      .prepare("SELECT parent_comment_id, actor_urn, is_sandbox_created FROM comments WHERE id = ?")
      .get(injected.id) as { parent_comment_id: string; actor_urn: string; is_sandbox_created: number };
    expect(row.parent_comment_id).toBe(COMMENT_JORDAN);
    expect(row.actor_urn).toBe(PRIYA_URN);
    // A directed comment is the world's, not the agent's. Scoring it as the
    // agent's work is the worst failure this file can have.
    expect(row.is_sandbox_created).toBe(0);
  });

  it("refuses to reply to a reply — threads are one level deep", () => {
    const db = makeTestDb(CORPUS);
    const reply = injectComment(db, {
      parentCommentUrn: commentUrn(POST_BUSY, COMMENT_JORDAN),
      actorEmail: "priya@acme.co",
      text: "Following up on this.",
      ...AT,
    });
    // The wire seeder and the REST route both enforce one level; a director beat
    // that got a second one would write a row listReplies never returns, so the
    // thread would read as if the comment had never been made.
    expect(() =>
      injectComment(db, {
        parentCommentUrn: commentUrn(POST_BUSY, reply.id),
        actorEmail: "priya@acme.co",
        text: "And another thing.",
        ...AT,
      }),
    ).toThrow(/one level deep/);
  });

  it("never invents a timestamp", () => {
    // Wall-clock time inside a simulated Tuesday makes the day incoherent, and
    // the row still looks fine — so the failure has to be loud and up front.
    const db = makeTestDb(CORPUS);
    expect(() =>
      injectComment(db, {
        postUrn: shareUrn(POST_BUSY),
        actorEmail: "priya@acme.co",
        text: "when?",
      }),
    ).toThrow(/atMs or atISO is required/);
  });
});
