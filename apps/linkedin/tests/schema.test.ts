import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CORPUS,
  COMMENT_JORDAN,
  DAN_URN,
  JORDAN_URN,
  makeTestDb,
  ORG_URN,
  OWNER_URN,
  POST_BUSY,
  POST_DRAFT,
  POST_PERSONAL,
  POST_QUIET,
  PRIYA_URN,
  at,
} from "./helpers";
import { listActions, logAction, startNewSession } from "@/lib/audit";
import { newPostId } from "@/lib/linkedin/ids";
import { activityUrn, commentUrn } from "@/lib/linkedin/urn";
import {
  countCommentsForPost,
  getCommentRow,
  insertComment,
  listReplies,
  listTopLevelComments,
} from "@/lib/store/comments";
import { insertMember } from "@/lib/store/members";
import {
  getLivePostRow,
  getPostRow,
  insertPost,
  listPostsByAuthor,
  tombstonePost,
} from "@/lib/store/posts";
import {
  getReaction,
  reactionCountsByType,
  reactionsForEntities,
  upsertReaction,
} from "@/lib/store/reactions";
import { hasApprovedAdminAcl, insertAcl } from "@/lib/store/organizations";

const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");

describe("schema", () => {
  it("creates every table the API reads", () => {
    const db = makeTestDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const table of [
      "meta",
      "members",
      "organizations",
      "organization_acls",
      "posts",
      "comments",
      "reactions",
      "sessions",
      "action_log",
    ]) {
      expect(names).toContain(table);
    }
  });

  it("indexes (author_urn, last_modified_ms) — every finder read depends on it", () => {
    const db = makeTestDb(CORPUS);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM posts WHERE author_urn = ? AND deleted_ms IS NULL
         ORDER BY last_modified_ms DESC`,
      )
      .all(ORG_URN) as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(" ")).toContain("idx_posts_author_modified");
  });

  it("cascades comments away when a post row is removed", () => {
    const db = makeTestDb(CORPUS);
    expect(countCommentsForPost(db, POST_BUSY).count).toBe(2);
    db.prepare("DELETE FROM posts WHERE id = ?").run(POST_BUSY);
    expect(countCommentsForPost(db, POST_BUSY).count).toBe(0);
  });

  it("rejects a second Priya under a different casing", () => {
    const db = makeTestDb();
    expect(() =>
      insertMember(db, {
        id: "someoneElse",
        email: "PRIYA@ACME.CO",
        givenName: "Priya",
        familyName: "Nair",
      }),
    ).toThrow(/UNIQUE/);
  });

  it("attributes a row to the world unless its writer says the agent made it", () => {
    // is_sandbox_created is what the judge reads to tell the agent's work from
    // the world's, and db/schema.sql declares DEFAULT 0. A store that defaulted
    // the other way would hand a future caller that forgets the flag the one
    // failure this column must never have: a seeded row scored as the agent's.
    const db = makeTestDb();
    const id = "7488111111111111111";
    insertPost(db, { id, authorUrn: ORG_URN, commentary: "", createdMs: at(0, 9), lastModifiedMs: at(0, 9) });
    expect(getPostRow(db, id)?.is_sandbox_created).toBe(0);

    const commentId = "7488111111111111112";
    insertComment(db, { id: commentId, postId: id, actorUrn: OWNER_URN, text: "hi", createdMs: at(0, 10) });
    expect(getCommentRow(db, commentId)?.is_sandbox_created).toBe(0);

    const entityUrn = activityUrn(id);
    upsertReaction(db, { actorUrn: OWNER_URN, entityUrn, reactionType: "LIKE", createdMs: at(0, 11) });
    expect(getReaction(db, OWNER_URN, entityUrn)?.is_sandbox_created).toBe(0);
  });

  it("applies cleanly to a fresh audit-only database", () => {
    const audit = new Database(":memory:");
    audit.exec(schema);
    const names = (
      audit.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toContain("action_log");
  });
});

describe("posts store", () => {
  it("hides a tombstoned post from the API but keeps it for the judge", () => {
    const db = makeTestDb(CORPUS);
    tombstonePost(db, POST_QUIET, at(3, 12));
    expect(getLivePostRow(db, POST_QUIET)).toBeNull();
    expect(getPostRow(db, POST_QUIET)?.commentary).toBe("Release 4.3 ships today.");
  });

  it("tombstones once and reports false the second time", () => {
    // This is what lets DELETE be idempotent without writing a second audit row
    // saying the agent destroyed two things.
    const db = makeTestDb(CORPUS);
    expect(tombstonePost(db, POST_QUIET, at(3, 12))).toBe(true);
    expect(tombstonePost(db, POST_QUIET, at(3, 13))).toBe(false);
  });

  it("excludes DRAFTs unless includeDrafts", () => {
    const db = makeTestDb(CORPUS);
    const q = { authorUrn: ORG_URN, sortBy: "LAST_MODIFIED" as const, start: 0, count: 10 };
    expect(listPostsByAuthor(db, { ...q, includeDrafts: false }).rows.map((r) => r.id)).not.toContain(
      POST_DRAFT,
    );
    expect(listPostsByAuthor(db, { ...q, includeDrafts: true }).rows.map((r) => r.id)).toContain(
      POST_DRAFT,
    );
  });

  it("scopes the finder to one author", () => {
    const db = makeTestDb(CORPUS);
    const rows = listPostsByAuthor(db, {
      authorUrn: OWNER_URN,
      sortBy: "LAST_MODIFIED",
      includeDrafts: false,
      start: 0,
      count: 10,
    }).rows;
    expect(rows.map((r) => r.id)).toEqual([POST_PERSONAL]);
  });

  it("honours both sortBy orderings", () => {
    const db = makeTestDb(CORPUS);
    // POST_QUIET was created last; POST_BUSY is edited afterwards, which puts it
    // first by LAST_MODIFIED and second by CREATED.
    db.prepare("UPDATE posts SET last_modified_ms = ? WHERE id = ?").run(at(5, 9), POST_BUSY);
    const byModified = listPostsByAuthor(db, {
      authorUrn: ORG_URN,
      sortBy: "LAST_MODIFIED",
      includeDrafts: true,
      start: 0,
      count: 10,
    }).rows;
    const byCreated = listPostsByAuthor(db, {
      authorUrn: ORG_URN,
      sortBy: "CREATED",
      includeDrafts: true,
      start: 0,
      count: 10,
    }).rows;
    expect(byModified[0].id).toBe(POST_BUSY);
    expect(byCreated[0].id).toBe(POST_DRAFT);
  });

  it("reports hasMore only while rows remain", () => {
    const db = makeTestDb(CORPUS);
    const page = (start: number, count: number) =>
      listPostsByAuthor(db, {
        authorUrn: ORG_URN,
        sortBy: "LAST_MODIFIED",
        includeDrafts: true,
        start,
        count,
      });
    expect(page(0, 2).hasMore).toBe(true);
    expect(page(2, 2).hasMore).toBe(false);
    expect(page(10, 2).rows).toHaveLength(0);
  });
});

describe("comments store", () => {
  it("separates top-level comments from replies", () => {
    const db = makeTestDb(CORPUS);
    expect(listTopLevelComments(db, POST_BUSY, { start: 0, count: 10 }).total).toBe(1);
    expect(listReplies(db, COMMENT_JORDAN, { start: 0, count: 10 }).total).toBe(1);
  });

  it("counts replies in count but not in topLevelCount", () => {
    const db = makeTestDb(CORPUS);
    expect(countCommentsForPost(db, POST_BUSY)).toEqual({ count: 2, topLevelCount: 1 });
  });

  it("reports zero for a post nobody commented on", () => {
    const db = makeTestDb(CORPUS);
    expect(countCommentsForPost(db, POST_QUIET)).toEqual({ count: 0, topLevelCount: 0 });
  });
});

describe("reactions store", () => {
  it("treats a second reaction from one actor as a change of mind", () => {
    const db = makeTestDb(CORPUS);
    const entity = activityUrn(POST_BUSY);
    const first = upsertReaction(db, {
      actorUrn: OWNER_URN,
      entityUrn: entity,
      reactionType: "LIKE",
      createdMs: at(1, 11),
      isSandboxCreated: true,
    });
    const second = upsertReaction(db, {
      actorUrn: OWNER_URN,
      entityUrn: entity,
      reactionType: "PRAISE",
      createdMs: at(1, 12),
      isSandboxCreated: true,
    });
    const rows = db
      .prepare("SELECT * FROM reactions WHERE actor_urn = ? AND entity_urn = ?")
      .all(OWNER_URN, entity);
    expect(rows).toHaveLength(1);
    expect(second.reaction_type).toBe("PRAISE");
    // The original created_ms survives; only last_modified moves.
    expect(second.created_ms).toBe(first.created_ms);
    expect(second.last_modified_ms).toBe(at(1, 12));
  });

  it("omits types nobody used", () => {
    const db = makeTestDb(CORPUS);
    const counts = reactionCountsByType(db, activityUrn(POST_BUSY));
    expect(counts).toEqual({ LIKE: 2, PRAISE: 1, EMPATHY: 1 });
    expect(counts.APPRECIATION).toBeUndefined();
  });

  it("batches a page of comments' likes into one map", () => {
    const db = makeTestDb(CORPUS);
    const urn = commentUrn(POST_BUSY, COMMENT_JORDAN);
    const map = reactionsForEntities(db, [urn, commentUrn(POST_BUSY, "nosuchcomment")]);
    expect(map.get(urn)).toHaveLength(4);
    expect(map.has(commentUrn(POST_BUSY, "nosuchcomment"))).toBe(false);
  });
});

describe("organization ACLs", () => {
  it("only an APPROVED ADMINISTRATOR may act as the page", () => {
    const db = makeTestDb();
    expect(hasApprovedAdminAcl(db, "7412903", "sHq2WpRk9L")).toBe(true);
    expect(hasApprovedAdminAcl(db, "7412903", "pR4nLz8YcW")).toBe(false);
    insertAcl(db, { organizationId: "7412903", memberId: "pR4nLz8YcW", state: "REQUESTED" });
    expect(hasApprovedAdminAcl(db, "7412903", "pR4nLz8YcW")).toBe(false);
  });
});

describe("post ids", () => {
  it("mints a 19-digit decimal string that sorts by creation time", () => {
    const earlier = newPostId(at(0, 9));
    const later = newPostId(at(1, 9));
    expect(earlier).toMatch(/^\d{19}$/);
    expect(later).toMatch(/^\d{19}$/);
    // The high bits are the timestamp, so lexical order over equal-length ids is
    // chronological order — an agent that sorts by id gets the same answer as
    // one that sorts by publishedAt.
    expect(earlier < later).toBe(true);
  });

  it("stays a string, because the value overflows a JS number", () => {
    const id = newPostId(at(0, 9));
    expect(Number(id)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(String(Number(id))).not.toBe(id);
  });
});

describe("audit", () => {
  it("writes exactly one row when the transaction commits", () => {
    const db = makeTestDb(CORPUS);
    startNewSession(db, "test", at(0, 9));
    const tx = db.transaction(() => {
      tombstonePost(db, POST_QUIET, at(3, 12));
      logAction(db, {
        method: "DELETE",
        endpoint: "/rest/posts",
        actionType: "postDelete",
        summary: "Deleted a post",
      });
    });
    tx();
    expect(listActions(db)).toHaveLength(1);
  });

  it("leaves no evidence of an action that rolled back", () => {
    const db = makeTestDb(CORPUS);
    startNewSession(db, "test", at(0, 9));
    const tx = db.transaction(() => {
      tombstonePost(db, POST_QUIET, at(3, 12));
      logAction(db, {
        method: "DELETE",
        endpoint: "/rest/posts",
        actionType: "postDelete",
        summary: "Deleted a post",
      });
      throw new Error("boom");
    });
    expect(() => tx()).toThrow("boom");
    expect(listActions(db)).toHaveLength(0);
    expect(getPostRow(db, POST_QUIET)?.deleted_ms).toBeNull();
  });
});

describe("the corpus itself", () => {
  it("gives the busy post an unanswered outsider and an answered reply", () => {
    const db = makeTestDb(CORPUS);
    const top = listTopLevelComments(db, POST_BUSY, { start: 0, count: 10 }).rows;
    expect(top[0].actor_urn).toBe(JORDAN_URN);
    const replies = listReplies(db, COMMENT_JORDAN, { start: 0, count: 10 }).rows;
    // A page reply carries the admin who wrote it, which is what `agent` and
    // `created.impersonator` are built from.
    expect(replies[0].actor_urn).toBe(ORG_URN);
    expect(replies[0].agent_urn).toBe(OWNER_URN);
  });

  it("seeds reactions from four distinct people", () => {
    const db = makeTestDb(CORPUS);
    const actors = (
      db
        .prepare("SELECT actor_urn FROM reactions WHERE entity_urn = ?")
        .all(activityUrn(POST_BUSY)) as Array<{ actor_urn: string }>
    ).map((r) => r.actor_urn);
    expect(new Set(actors)).toEqual(new Set([PRIYA_URN, DAN_URN, "urn:li:person:mB9tGx3JdV", JORDAN_URN]));
  });
});
