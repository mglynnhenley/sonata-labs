import { describe, it, expect } from "vitest";
import {
  CORPUS,
  DAN_URN,
  makeTestDb,
  ORG_URN,
  OWNER_PERSON_ID,
  OWNER_URN,
  POST_BUSY,
  POST_DRAFT,
  POST_PERSONAL,
  at,
} from "./helpers";
import { buildCreateInput, buildPatchInput } from "@/lib/linkedin/post-input";
import { mayActAs, requirePostAuthor } from "@/lib/linkedin/actor";
import { LinkedInError } from "@/lib/linkedin/errors";
import { getPostRow, tombstonePost } from "@/lib/store/posts";

// The create and patch validators carry every documented 400 and 403 on the
// clone's two headline writes, so they are tested against the error each failure
// is supposed to produce rather than merely against "it threw".

const VALID = {
  author: ORG_URN,
  commentary: "Sample text post",
  visibility: "PUBLIC",
  distribution: {
    feedDistribution: "MAIN_FEED",
    targetEntities: [],
    thirdPartyDistributionChannels: [],
  },
  lifecycleState: "PUBLISHED",
  isReshareDisabledByAuthor: false,
};

function create(body: Record<string, unknown>) {
  const db = makeTestDb(CORPUS);
  return buildCreateInput(body, { db, ownerMemberId: OWNER_PERSON_ID, now: at(2, 9) });
}

function expectError(fn: () => unknown, status: number, code: string): void {
  try {
    fn();
    throw new Error("expected a LinkedInError but the call succeeded");
  } catch (err) {
    expect(err).toBeInstanceOf(LinkedInError);
    const e = err as LinkedInError;
    expect({ status: e.status, code: e.code }).toEqual({ status, code });
  }
}

describe("buildCreateInput", () => {
  it("accepts LinkedIn's documented body and stamps all three timestamps", () => {
    const input = create({ ...VALID });
    expect(input.authorUrn).toBe(ORG_URN);
    expect(input.commentary).toBe("Sample text post");
    expect(input.createdMs).toBe(at(2, 9));
    expect(input.publishedMs).toBe(at(2, 9));
    expect(input.lastModifiedMs).toBe(at(2, 9));
    expect(input.id).toMatch(/^\d{19}$/);
  });

  it("requires author, visibility, distribution and lifecycleState", () => {
    for (const field of ["author", "visibility", "distribution", "lifecycleState"]) {
      const body = { ...VALID } as Record<string, unknown>;
      delete body[field];
      expectError(() => create(body), 400, "MISSING_FIELD");
    }
  });

  it("does NOT require commentary, and does not reject a blank one", () => {
    // LinkedIn's MISSING_FIELD table does not name commentary, and its own
    // finder samples return live posts with `"commentary": ""` — that is what a
    // media-only post looks like.
    const body = { ...VALID } as Record<string, unknown>;
    delete body.commentary;
    expect(create(body).commentary).toBe("");
    expect(create({ ...VALID, commentary: "" }).commentary).toBe("");
  });

  it("refuses commentary past 3000 characters", () => {
    expectError(
      () => create({ ...VALID, commentary: "x".repeat(3001) }),
      400,
      "FIELD_LENGTH_TOO_LONG",
    );
    expect(create({ ...VALID, commentary: "x".repeat(3000) }).commentary).toHaveLength(3000);
  });

  it("refuses DRAFT on create — PUBLISHED is the only value LinkedIn accepts", () => {
    expectError(
      () => create({ ...VALID, lifecycleState: "DRAFT" }),
      400,
      "INVALID_VALUE_FOR_FIELD",
    );
  });

  it("refuses a visibility outside the three documented values", () => {
    expectError(() => create({ ...VALID, visibility: "PRIVATE" }), 400, "INVALID_VALUE_FOR_FIELD");
  });

  it("refuses an author that is not a person or organization URN", () => {
    expectError(
      () => create({ ...VALID, author: "urn:li:share:7487797749352832044" }),
      400,
      "INVALID_URN_TYPE",
    );
  });

  it("refuses a well-formed author URN naming nobody", () => {
    expectError(() => create({ ...VALID, author: "urn:li:organization:99" }), 400, "INVALID_URN_ID");
  });

  it("refuses an organization the owner does not administer", () => {
    const db = makeTestDb(CORPUS);
    db.prepare("DELETE FROM organization_acls").run();
    expectError(
      () => buildCreateInput({ ...VALID }, { db, ownerMemberId: OWNER_PERSON_ID, now: at(2, 9) }),
      403,
      "ACCESS_DENIED",
    );
  });

  it("refuses posting as another member", () => {
    expectError(() => create({ ...VALID, author: DAN_URN }), 403, "ACCESS_DENIED");
  });

  it("lets the owner post as themself", () => {
    expect(create({ ...VALID, author: OWNER_URN }).authorUrn).toBe(OWNER_URN);
  });

  it("keeps the passthrough keys and drops everything else", () => {
    const input = create({
      ...VALID,
      content: { article: { source: "https://example.com" } },
      contentCallToActionLabel: "LEARN_MORE",
      adContext: { dscAdAccount: "urn:li:sponsoredAccount:1" },
    });
    expect(input.extra).toEqual({
      content: { article: { source: "https://example.com" } },
      contentCallToActionLabel: "LEARN_MORE",
    });
  });
});

describe("buildPatchInput", () => {
  const db = makeTestDb(CORPUS);
  const busy = getPostRow(db, POST_BUSY)!;
  const draft = getPostRow(db, POST_DRAFT)!;

  it("marks any edit as edited by the author and bumps lastModified", () => {
    const { patch } = buildPatchInput({ $set: { commentary: "fixed" } }, busy, at(2, 9));
    expect(patch).toMatchObject({ commentary: "fixed", isEdited: true, lastModifiedMs: at(2, 9) });
    expect(patch.publishedMs).toBeUndefined();
  });

  it("refuses a patch that sets nothing rather than logging an edit nobody made", () => {
    // The route wraps this in runMutation, so a patch that "succeeds" while
    // changing nothing still writes `Edited the post "…"` into the log the judge
    // grades from, flips isEditedByAuthor, and moves the post to the top of the
    // company feed — lastModifiedAt is the author finder's default sort key.
    for (const body of [{ $set: {} }, {}, undefined, null, "nonsense"]) {
      expectError(() => buildPatchInput(body, busy, at(2, 9)), 400, "MISSING_FIELD");
    }
  });

  it("refuses a key outside the four LinkedIn documents as settable", () => {
    expectError(
      () => buildPatchInput({ $set: { visibility: "CONNECTIONS" } }, busy, at(2, 9)),
      403,
      "ACCESS_DENIED",
    );
  });

  it("names every offending path in the refusal", () => {
    try {
      buildPatchInput({ $set: { visibility: "CONNECTIONS", author: ORG_URN } }, busy, at(2, 9));
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as LinkedInError).message).toContain(
        "[/patch/$set/visibility, /patch/$set/author]",
      );
    }
  });

  it("refuses the adContext sibling rather than silently ignoring it", () => {
    // It rides as a SIBLING of $set in LinkedIn's documented body, so a naive
    // reader of $set would no-op it and let an agent believe it set an ad field.
    expectError(
      () => buildPatchInput({ $set: {}, adContext: { $set: { dscName: "x" } } }, busy, at(2, 9)),
      403,
      "ACCESS_DENIED",
    );
  });

  it("stamps publishedAt on the DRAFT -> PUBLISHED transition, once", () => {
    const first = buildPatchInput({ $set: { lifecycleState: "PUBLISHED" } }, draft, at(4, 17));
    expect(first.publishesDraft).toBe(true);
    expect(first.patch.publishedMs).toBe(at(4, 17));

    // A second patch of an already-published post must not move the publish time.
    const published = { ...draft, lifecycle_state: "PUBLISHED", published_ms: at(4, 17) };
    const second = buildPatchInput({ $set: { commentary: "typo" } }, published, at(5, 9));
    expect(second.publishesDraft).toBe(false);
    expect(second.patch.publishedMs).toBeUndefined();
  });

  it("merges passthrough rather than replacing it", () => {
    const withContent = {
      ...busy,
      raw_json: JSON.stringify({ content: { article: { source: "https://example.com" } } }),
    };
    const { patch } = buildPatchInput(
      { $set: { contentCallToActionLabel: "LEARN_MORE" } },
      withContent,
      at(2, 9),
    );
    expect(patch.extra).toEqual({
      content: { article: { source: "https://example.com" } },
      contentCallToActionLabel: "LEARN_MORE",
    });
  });

  it("refuses un-publishing a live post, which is a takedown wearing an edit's clothes", () => {
    // DRAFT on a PUBLISHED post is functionally a delete — the post 404s for
    // every reader and leaves the author finder — but publishesDraft is false,
    // so the trail would say `Edited the post "…"` and postDelete would never be
    // written. It would also leave published_ms set, and a DRAFT carrying a
    // publishedAt is the state shape.ts and sandbox/parse.ts both call impossible.
    expectError(
      () => buildPatchInput({ $set: { lifecycleState: "DRAFT" } }, busy, at(2, 9)),
      400,
      "INVALID_VALUE_FOR_FIELD",
    );
    // Still a no-op on a post that is already a draft: the refusal is about the
    // backwards TRANSITION, not about the word.
    const { patch } = buildPatchInput({ $set: { lifecycleState: "DRAFT" } }, draft, at(2, 9));
    expect(patch.lifecycleState).toBe("DRAFT");
    expect(patch.publishedMs).toBeUndefined();
  });

  it("refuses a lifecycleState LinkedIn does not have", () => {
    expectError(
      () => buildPatchInput({ $set: { lifecycleState: "ARCHIVED" } }, busy, at(2, 9)),
      400,
      "INVALID_VALUE_FOR_FIELD",
    );
  });
});

describe("requirePostAuthor", () => {
  // The gate on editing and deleting. It is separate from buildPatchInput
  // because a patch body names no actor at all — the only thing that says whose
  // post this is, is the post.
  const DANS_POST = "7488111111111111111";
  const corpus = [
    ...CORPUS,
    { id: DANS_POST, authorUrn: DAN_URN, commentary: "Dan's own post", createdMs: at(1, 8) },
  ];

  function gate(db: ReturnType<typeof makeTestDb>, postId: string): void {
    requirePostAuthor(db, getPostRow(db, postId)!.author_urn, {
      ownerMemberId: OWNER_PERSON_ID,
      action: "DELETE /posts",
    });
  }

  it("lets the owner edit their own post and the page's", () => {
    const db = makeTestDb(corpus);
    expect(() => gate(db, POST_PERSONAL)).not.toThrow();
    expect(() => gate(db, POST_BUSY)).not.toThrow();
  });

  it("refuses another member's post with a 403, not a 404", () => {
    // The caller can SEE the post — it is public — so LinkedIn answers 403.
    // A 404 would tell an agent the post does not exist, which is a different
    // and wrong lesson.
    const db = makeTestDb(corpus);
    expectError(() => gate(db, DANS_POST), 403, "ACCESS_DENIED");
  });

  it("refuses the page's post once the ADMINISTRATOR role is gone", () => {
    const db = makeTestDb(corpus);
    db.prepare("DELETE FROM organization_acls").run();
    expectError(() => gate(db, POST_BUSY), 403, "ACCESS_DENIED");
  });

  it("still refuses a post that is already tombstoned", () => {
    // DELETE is idempotent, and the second call has to be the same refusal —
    // otherwise the 204 reads as "already gone" and the agent learns it won.
    const db = makeTestDb(corpus);
    tombstonePost(db, DANS_POST, at(2, 9));
    expectError(() => gate(db, DANS_POST), 403, "ACCESS_DENIED");
  });

  it("answers the same question as a boolean for the DRAFT reader", () => {
    // Both posts routes ask this before honouring viewContext=AUTHOR, and they
    // need a yes/no rather than a throw: an unpublished post belongs to its
    // author, so a stranger asking for one gets the reader's 404 and not a 403
    // that would confirm the draft is there.
    const db = makeTestDb(corpus);
    expect(mayActAs(db, OWNER_URN, OWNER_PERSON_ID)).toBe(true);
    expect(mayActAs(db, ORG_URN, OWNER_PERSON_ID)).toBe(true);
    expect(mayActAs(db, DAN_URN, OWNER_PERSON_ID)).toBe(false);
    expect(mayActAs(db, "urn:li:person:neverHeardOf", OWNER_PERSON_ID)).toBe(false);
    expect(mayActAs(db, "not-a-urn", OWNER_PERSON_ID)).toBe(false);
    db.prepare("DELETE FROM organization_acls").run();
    expect(mayActAs(db, ORG_URN, OWNER_PERSON_ID)).toBe(false);
  });
});
