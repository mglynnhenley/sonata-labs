import { describe, it, expect } from "vitest";
import {
  activityUrn,
  canonicalEntityUrn,
  commentUrn,
  decodeUrnParam,
  likeUrn,
  organizationUrn,
  parseCommentUrn,
  parseUrn,
  personUrn,
  postIdFromUrn,
  reactionUrn,
  shareUrn,
} from "@/lib/linkedin/urn";

// The URN algebra gets its own suite because everything else in the clone is
// built on it: the id an agent reads off a comment is the id it hands back to
// the posts endpoint, and if those two spellings disagree nothing else matters.

const POST_ID = "7487797749352832044";
const COMMENT_ID = "7487809828949811964";

describe("formatters and parseUrn", () => {
  it("round-trips every simple URN kind", () => {
    const cases: Array<[string, string, string]> = [
      [personUrn("sHq2WpRk9L"), "person", "sHq2WpRk9L"],
      [organizationUrn("7412903"), "organization", "7412903"],
      [shareUrn(POST_ID), "share", POST_ID],
      [activityUrn(POST_ID), "activity", POST_ID],
      [`urn:li:ugcPost:${POST_ID}`, "ugcPost", POST_ID],
    ];
    for (const [urn, kind, id] of cases) {
      expect(parseUrn(urn)).toEqual({ kind, id });
    }
  });

  it("accepts the underscore-and-hyphen alphabet real person ids use", () => {
    expect(parseUrn("urn:li:person:A8x-e0_Qt1")).toEqual({ kind: "person", id: "A8x-e0_Qt1" });
  });
});

describe("postIdFromUrn", () => {
  it("returns the same id for all three post spellings", () => {
    for (const urn of [shareUrn(POST_ID), activityUrn(POST_ID), `urn:li:ugcPost:${POST_ID}`]) {
      expect(postIdFromUrn(urn)).toBe(POST_ID);
    }
  });

  it("refuses a person URN — an author is not a post", () => {
    expect(postIdFromUrn(personUrn("sHq2WpRk9L"))).toBeNull();
  });
});

describe("comment URNs", () => {
  it("builds the composite with the ACTIVITY urn, never the share urn", () => {
    expect(commentUrn(POST_ID, COMMENT_ID)).toBe(
      `urn:li:comment:(urn:li:activity:${POST_ID},${COMMENT_ID})`,
    );
  });

  it("splits a composite back apart, 19-digit ids and all", () => {
    expect(parseCommentUrn(commentUrn(POST_ID, COMMENT_ID))).toEqual({
      postId: POST_ID,
      commentId: COMMENT_ID,
    });
  });

  it("parseUrn recognises a composite as a comment", () => {
    expect(parseUrn(commentUrn(POST_ID, COMMENT_ID))).toEqual({
      kind: "comment",
      id: COMMENT_ID,
    });
  });
});

describe("canonicalEntityUrn", () => {
  it("collapses all three post spellings onto the activity form", () => {
    for (const urn of [shareUrn(POST_ID), activityUrn(POST_ID), `urn:li:ugcPost:${POST_ID}`]) {
      // Without one canonical spelling, the same actor liking by two different
      // URNs would land as two rows and be counted twice.
      expect(canonicalEntityUrn(urn)).toBe(activityUrn(POST_ID));
    }
  });

  it("leaves a comment URN untouched, because a string cannot canonicalise one", () => {
    // Only the comment row can say whether the thread half is right, and this
    // file is database-free — so the callers that hold a `db` finish the job
    // (see requireComment in route-helpers, and tests/route-helpers.test.ts).
    const urn = commentUrn(POST_ID, COMMENT_ID);
    expect(canonicalEntityUrn(urn)).toBe(urn);
  });

  it("rejects an entity that can carry no reaction", () => {
    expect(canonicalEntityUrn(personUrn("sHq2WpRk9L"))).toBeNull();
  });
});

describe("composite reaction and like URNs", () => {
  it("produce the parenthesised forms the samples show", () => {
    const actor = personUrn("sHq2WpRk9L");
    expect(reactionUrn(actor, activityUrn(POST_ID))).toBe(
      `urn:li:reaction:(${actor},urn:li:activity:${POST_ID})`,
    );
    expect(likeUrn(actor, commentUrn(POST_ID, COMMENT_ID))).toBe(
      `urn:li:like:(${actor},urn:li:comment:(urn:li:activity:${POST_ID},${COMMENT_ID}))`,
    );
  });
});

describe("garbage input", () => {
  // A 500 where LinkedIn answers 400 is the failure this block exists to stop.
  const GARBAGE = [
    "",
    "urn:li",
    "urn:li:share:",
    "urn:li:share:abc",
    "urn:li:comment:(broken",
    "urn:li:comment:(urn:li:share:1,2)",
    "7487797749352832044",
    "urn:li:person:has spaces",
  ];

  it("returns null and never throws", () => {
    for (const value of GARBAGE) {
      expect(() => parseUrn(value)).not.toThrow();
      expect(parseUrn(value)).toBeNull();
      expect(postIdFromUrn(value)).toBeNull();
      expect(canonicalEntityUrn(value)).toBeNull();
    }
  });
});

describe("decodeUrnParam", () => {
  it("leaves an already-decoded URN alone", () => {
    expect(decodeUrnParam(shareUrn(POST_ID))).toBe(shareUrn(POST_ID));
  });

  it("decodes a double-encoded one exactly once", () => {
    expect(decodeUrnParam(encodeURIComponent(shareUrn(POST_ID)))).toBe(shareUrn(POST_ID));
  });

  it("returns a malformed escape unchanged rather than throwing", () => {
    expect(decodeUrnParam("urn:li:share:%zz")).toBe("urn:li:share:%zz");
  });
});
