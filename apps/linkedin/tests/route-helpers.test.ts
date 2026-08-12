import { describe, it, expect } from "vitest";
import {
  COMMENT_JORDAN,
  COMMENT_PAGE_REPLY,
  CORPUS,
  JORDAN_URN,
  makeTestDb,
  POST_BUSY,
  POST_DRAFT,
  POST_QUIET,
  at,
} from "./helpers";
import { requireComment, requirePost, requirePublishedPost } from "@/lib/linkedin/route-helpers";
import { LinkedInError } from "@/lib/linkedin/errors";
import { activityUrn, commentUrn, shareUrn } from "@/lib/linkedin/urn";
import { tombstonePost } from "@/lib/store/posts";
import { reactionCountsByType, upsertReaction } from "@/lib/store/reactions";

// The resolvers every engagement route shares. Each of them is the only thing
// standing between a URN a caller invented and a row nobody can ever read back:
// socialMetadata answering 200 for a DRAFT leaks a post the posts endpoint has
// just 404ed, and a comment URN resolved by its comment id alone keys a reaction
// under a string no reader derives.

function expect404(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected a 404 but the call succeeded");
  } catch (err) {
    expect(err).toBeInstanceOf(LinkedInError);
    expect((err as LinkedInError).status).toBe(404);
    expect((err as LinkedInError).code).toBe("NOT_FOUND");
  }
}

describe("requirePost", () => {
  it("resolves all three post spellings onto one row", () => {
    const db = makeTestDb(CORPUS);
    for (const urn of [shareUrn(POST_BUSY), activityUrn(POST_BUSY), `urn:li:ugcPost:${POST_BUSY}`]) {
      expect(requirePost(db, urn).id).toBe(POST_BUSY);
    }
  });

  it("404s a tombstoned post, and anything that is not a post URN", () => {
    const db = makeTestDb(CORPUS);
    tombstonePost(db, POST_QUIET, at(3, 12));
    expect404(() => requirePost(db, shareUrn(POST_QUIET)));
    expect404(() => requirePost(db, "urn:li:person:sHq2WpRk9L"));
  });

  it("still resolves a DRAFT — the posts resource decides who may see one", () => {
    // viewContext=AUTHOR is a real read, and publishing the draft is a patch of
    // it, so the plain resolver cannot be the one that hides it.
    const db = makeTestDb(CORPUS);
    expect(requirePost(db, shareUrn(POST_DRAFT)).lifecycle_state).toBe("DRAFT");
  });
});

describe("requirePublishedPost", () => {
  it("404s the DRAFT that requirePost resolves", () => {
    const db = makeTestDb(CORPUS);
    expect404(() => requirePublishedPost(db, shareUrn(POST_DRAFT)));
    expect404(() => requirePublishedPost(db, activityUrn(POST_DRAFT)));
  });

  it("hands back a published post unchanged", () => {
    const db = makeTestDb(CORPUS);
    expect(requirePublishedPost(db, activityUrn(POST_BUSY)).id).toBe(POST_BUSY);
  });
});

describe("requireComment", () => {
  const good = commentUrn(POST_BUSY, COMMENT_JORDAN);

  it("resolves the composite the readers build", () => {
    const db = makeTestDb(CORPUS);
    const row = requireComment(db, good);
    expect(row.id).toBe(COMMENT_JORDAN);
    expect(commentUrn(row.post_id, row.id)).toBe(good);
  });

  it("404s the right comment named on the wrong thread", () => {
    // The near miss the clone has to refuse: this URN names a comment that
    // exists, on a post that exists, and the pair is a fiction.
    const db = makeTestDb(CORPUS);
    expect404(() => requireComment(db, commentUrn(POST_QUIET, COMMENT_JORDAN)));
    expect404(() => requireComment(db, commentUrn("1111111111111111111", COMMENT_JORDAN)));
  });

  it("404s an unknown comment id, a post URN and garbage alike", () => {
    const db = makeTestDb(CORPUS);
    expect404(() => requireComment(db, commentUrn(POST_BUSY, "1111111111111111111")));
    expect404(() => requireComment(db, shareUrn(POST_BUSY)));
    expect404(() => requireComment(db, "urn:li:comment:(broken"));
  });

  it("collapses a comment's reactions onto one row per actor", () => {
    const db = makeTestDb(CORPUS);
    const nearMiss = commentUrn(POST_QUIET, COMMENT_JORDAN);
    // Exactly what a reaction write does with the caller's `root`: resolve it,
    // then key the row on the URN rebuilt from the row it resolved to.
    const key = (urn: string): string => {
      const row = requireComment(db, urn);
      return commentUrn(row.post_id, row.id);
    };
    expect(key(good)).toBe(good);
    expect(() => key(nearMiss)).toThrow(LinkedInError);

    upsertReaction(db, {
      actorUrn: JORDAN_URN,
      entityUrn: key(good),
      reactionType: "LIKE",
      createdMs: at(1, 11),
    });
    upsertReaction(db, {
      actorUrn: JORDAN_URN,
      entityUrn: key(good),
      reactionType: "PRAISE",
      createdMs: at(1, 12),
    });

    // Four seeded likers plus Jordan, once — not twice, and nothing parked under
    // a spelling socialMetadata will never ask about.
    const counts = reactionCountsByType(db, good);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(5);
    const orphans = db
      .prepare("SELECT COUNT(*) AS n FROM reactions WHERE entity_urn = ?")
      .get(nearMiss) as { n: number };
    expect(orphans.n).toBe(0);
  });

  it("resolves a reply by its own composite, not by its parent's", () => {
    const db = makeTestDb(CORPUS);
    const reply = requireComment(db, commentUrn(POST_BUSY, COMMENT_PAGE_REPLY));
    expect(reply.parent_comment_id).toBe(COMMENT_JORDAN);
  });
});
