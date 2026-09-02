import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AUDIT_DDL } from "@/lib/db";
import {
  COMMENT_JORDAN,
  ORG_ID,
  ORG_URN,
  OWNER_EMAIL,
  OWNER_PERSON_ID,
  OWNER_URN,
  POST_DRAFT,
  POST_POSTMORTEM,
  POST_RELEASE,
  seedDatabase,
} from "@/lib/seed";
import { BadRequestError, parseSeedRequest } from "@/lib/sandbox/parse";
import { activityUrn, commentUrn } from "@/lib/linkedin/urn";
import { countCommentsForPost } from "@/lib/store/comments";
import { countAll } from "@/lib/store/counts";
import { getOwnerMember } from "@/lib/store/members";
import { getPostRow } from "@/lib/store/posts";
import { hasApprovedAdminAcl } from "@/lib/store/organizations";
import { reactionCountsByType } from "@/lib/store/reactions";
import { trackDb } from "./helpers";

const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");

function freshDb(): Database.Database {
  const db = trackDb(new Database(":memory:"));
  db.exec(schema);
  db.prepare("ATTACH DATABASE ':memory:' AS audit").run();
  db.exec(AUDIT_DDL);
  return db;
}

describe("the demo seed", () => {
  it("builds the Acme page with the counts the CLI prints", () => {
    const db = freshDb();
    seedDatabase(db);
    expect(countAll(db)).toEqual({
      members: 12,
      organizations: 1,
      posts: 7,
      comments: 17,
      reactions: 40,
    });
  });

  it("is reproducible: two seeds produce identical rows", () => {
    // A demo seed that drifts run-to-run makes every screenshot and every
    // hand-written smoke assertion a moving target.
    const a = freshDb();
    const b = freshDb();
    seedDatabase(a);
    seedDatabase(b);
    const dump = (db: Database.Database) =>
      JSON.stringify([
        db.prepare("SELECT * FROM posts ORDER BY id").all(),
        db.prepare("SELECT * FROM comments ORDER BY id").all(),
        db.prepare("SELECT * FROM reactions ORDER BY actor_urn, entity_urn").all(),
      ]);
    expect(dump(a)).toBe(dump(b));
  });

  it("makes the owner an APPROVED ADMINISTRATOR and leaves Dan asking", () => {
    const db = freshDb();
    seedDatabase(db);
    expect(hasApprovedAdminAcl(db, ORG_ID, OWNER_PERSON_ID)).toBe(true);
    expect(hasApprovedAdminAcl(db, ORG_ID, "pR4nLz8YcW")).toBe(false);
  });

  it("answers /v2/userinfo as the shared cast's owner", () => {
    const db = freshDb();
    seedDatabase(db);
    expect(getOwnerMember(db)?.email).toBe(OWNER_EMAIL);
    expect(getOwnerMember(db)?.id).toBe(OWNER_PERSON_ID);
  });

  it("weights engagement so 'check the engagement' has a right answer", () => {
    const db = freshDb();
    seedDatabase(db);
    const busy = reactionCountsByType(db, activityUrn(POST_POSTMORTEM));
    expect(Object.values(busy).reduce((a, b) => a + b, 0)).toBe(11);
    expect(countCommentsForPost(db, POST_POSTMORTEM)).toEqual({ count: 9, topLevelCount: 7 });
    // And one post with nothing at all, so the comments finder's documented 404
    // is a state the seed actually reaches.
    expect(countCommentsForPost(db, POST_RELEASE)).toEqual({ count: 0, topLevelCount: 0 });
  });

  it("leaves the outsider's question unanswered", () => {
    const db = freshDb();
    seedDatabase(db);
    const replies = db
      .prepare("SELECT COUNT(*) AS n FROM comments WHERE parent_comment_id = ?")
      .get(COMMENT_JORDAN) as { n: number };
    expect(replies.n).toBe(0);
  });

  it("caps the busiest comment's like preview by giving it four likers", () => {
    const db = freshDb();
    seedDatabase(db);
    const likes = db
      .prepare("SELECT COUNT(*) AS n FROM reactions WHERE entity_urn = ?")
      .get(commentUrn(POST_POSTMORTEM, COMMENT_JORDAN)) as { n: number };
    expect(likes.n).toBe(4);
  });

  it("carries a DRAFT with no publish time", () => {
    const db = freshDb();
    seedDatabase(db);
    const draft = getPostRow(db, POST_DRAFT);
    expect(draft?.lifecycle_state).toBe("DRAFT");
    expect(draft?.published_ms).toBeNull();
  });

  it("marks nothing as sandbox-created", () => {
    const db = freshDb();
    seedDatabase(db);
    for (const table of ["posts", "comments", "reactions"]) {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE is_sandbox_created = 1`)
        .get() as { n: number };
      expect(row.n).toBe(0);
    }
  });
});

// --- the wire seed -----------------------------------------------------------

const CAST = [
  { id: "p1", name: "Sandbox User", email: OWNER_EMAIL },
  { id: "p2", name: "Priya Nair", email: "priya@acme.co" },
  { id: "p3", name: "Jordan Rivera", email: "j.rivera@example.com" },
];

function wire(overrides: Record<string, unknown> = {}): unknown {
  return {
    twin: "linkedin",
    seed: {
      world: { business: { name: "Acme" }, cast: CAST, mailboxOwner: OWNER_EMAIL },
      nowISO: "2026-07-27T09:00:00Z",
      ownerEmail: OWNER_EMAIL,
      organization: { id: ORG_ID, name: "Acme", vanityName: "acme-co" },
      members: [
        { email: OWNER_EMAIL, personId: OWNER_PERSON_ID },
        { email: "priya@acme.co", personId: "dK7mQv2XbT" },
        { email: "j.rivera@example.com", personId: "xF5cNr7QsE" },
      ],
      posts: [
        {
          id: POST_POSTMORTEM,
          authorKind: "organization",
          commentary: "Post-mortem",
          visibility: "PUBLIC",
          lifecycleState: "PUBLISHED",
          publishedISO: "2026-07-28T09:15:00Z",
          comments: [
            {
              id: COMMENT_JORDAN,
              actorKind: "member",
              actorEmail: "j.rivera@example.com",
              text: "What is the escalation path?",
              createdISO: "2026-07-28T10:03:00Z",
              replies: [
                {
                  id: "7487823670150563750",
                  actorKind: "organization",
                  text: "We page named accounts directly.",
                  createdISO: "2026-07-28T10:58:00Z",
                },
              ],
            },
          ],
          reactions: [
            { actorEmail: "priya@acme.co", reactionType: "LIKE", createdISO: "2026-07-28T09:20:00Z" },
          ],
        },
      ],
      ...overrides,
    },
  };
}

describe("parseSeedRequest", () => {
  it("accepts a well-formed wire seed and flattens replies after their parent", () => {
    const parsed = parseSeedRequest(wire());
    expect(parsed.ownerPersonId).toBe(OWNER_PERSON_ID);
    expect(parsed.businessName).toBe("Acme");
    const comments = parsed.posts[0].comments;
    expect(comments.map((c) => c.parentCommentId)).toEqual([null, COMMENT_JORDAN]);
    // A page's own reply carries the admin who wrote it.
    expect(comments[1].actorUrn).toBe(ORG_URN);
    expect(comments[1].agentUrn).toBe(OWNER_URN);
  });

  it("rejects a mis-routed seed loudly", () => {
    // The alternative is an empty company page that answers 200.
    expect(() => parseSeedRequest({ twin: "slack", seed: {} })).toThrow(/seeds 'linkedin'/);
  });

  it("rejects a commenter the world has never heard of", () => {
    const body = wire() as { seed: { posts: Array<{ comments: Array<{ actorEmail: string }> }> } };
    body.seed.posts[0].comments[0].actorEmail = "stranger@example.com";
    expect(() => parseSeedRequest(body)).toThrow(/no seed.members entry/);
  });

  it("rejects a member who is not in the cast", () => {
    const body = wire() as { seed: { members: Array<{ email: string }> } };
    body.seed.members[2].email = "stranger@example.com";
    expect(() => parseSeedRequest(body)).toThrow(/is not in seed.world.cast/);
  });

  it("rejects an owner with no LinkedIn identity", () => {
    const body = wire() as { seed: { members: unknown[] } };
    body.seed.members = body.seed.members.slice(1);
    expect(() => parseSeedRequest(body)).toThrow(/has no seed.members entry/);
  });

  it("rejects duplicate post ids, comment ids and person ids", () => {
    const dupPosts = wire() as { seed: { posts: unknown[] } };
    dupPosts.seed.posts = [dupPosts.seed.posts[0], dupPosts.seed.posts[0]];
    expect(() => parseSeedRequest(dupPosts)).toThrow(/two posts with id/);

    const dupPeople = wire() as { seed: { members: Array<{ personId: string }> } };
    dupPeople.seed.members[1].personId = OWNER_PERSON_ID;
    expect(() => parseSeedRequest(dupPeople)).toThrow(/reuses personId/);
  });

  it("rejects a DRAFT that carries engagement", () => {
    const body = wire() as { seed: { posts: Array<{ lifecycleState: string }> } };
    body.seed.posts[0].lifecycleState = "DRAFT";
    expect(() => parseSeedRequest(body)).toThrow(/nobody can comment on or react to/);
  });

  it("names MAYBE as deprecated rather than merely unknown", () => {
    const body = wire() as {
      seed: { posts: Array<{ reactions: Array<{ reactionType: string }> }> };
    };
    body.seed.posts[0].reactions[0].reactionType = "MAYBE";
    expect(() => parseSeedRequest(body)).toThrow(/deprecated in LinkedIn version 202307/);
  });

  it("rejects one member reacting twice to the same entity", () => {
    const body = wire() as { seed: { posts: Array<{ reactions: unknown[] }> } };
    body.seed.posts[0].reactions = [
      { actorEmail: "priya@acme.co", reactionType: "LIKE", createdISO: "2026-07-28T09:20:00Z" },
      { actorEmail: "priya@acme.co", reactionType: "PRAISE", createdISO: "2026-07-28T09:40:00Z" },
    ];
    expect(() => parseSeedRequest(body)).toThrow(/reacts to the same entity twice/);
  });

  it("rejects a second level of replies", () => {
    const body = wire() as {
      seed: { posts: Array<{ comments: Array<{ replies: Array<Record<string, unknown>> }> }> };
    };
    body.seed.posts[0].comments[0].replies[0].replies = [
      {
        id: "7487889604609705447",
        actorKind: "member",
        actorEmail: "priya@acme.co",
        text: "nested",
        createdISO: "2026-07-28T11:00:00Z",
      },
    ];
    expect(() => parseSeedRequest(body)).toThrow(/one level deep/);
    // And it names the key the seed's author actually wrote. Reporting the
    // offending entry at `.comments[0].comments[0]` sends them looking for a
    // `comments` array that is not there.
    expect(() => parseSeedRequest(body)).toThrow(
      /seed\.posts\[0\]\.comments\[0\]\.replies\[0\]\.replies nests a second level/,
    );
  });

  it("throws BadRequestError, so the route answers 400 rather than 500", () => {
    expect(() => parseSeedRequest(null)).toThrow(BadRequestError);
  });

  it("leaves a DRAFT with no publish time", () => {
    const body = wire() as {
      seed: { posts: Array<Record<string, unknown>> };
    };
    body.seed.posts[0].lifecycleState = "DRAFT";
    body.seed.posts[0].comments = [];
    body.seed.posts[0].reactions = [];
    expect(parseSeedRequest(body).posts[0].publishedMs).toBeNull();
  });
});
