import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AUDIT_DDL } from "@/lib/db";
import { activityUrn, commentUrn, organizationUrn, personUrn } from "@/lib/linkedin/urn";
import { insertComment } from "@/lib/store/comments";
import { insertMember } from "@/lib/store/members";
import { setMeta } from "@/lib/store/meta";
import { insertAcl, insertOrganization } from "@/lib/store/organizations";
import { insertPost } from "@/lib/store/posts";
import { upsertReaction } from "@/lib/store/reactions";

// The whole test harness. It reads the REAL db/schema.sql off disk rather than
// restating it, so a schema regression fails the suite instead of hiding behind
// a fixture that drifted.

const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");

export const OWNER_EMAIL = "sandbox.user@gmail.com";
export const OWNER_PERSON_ID = "sHq2WpRk9L";
export const OWNER_URN = personUrn(OWNER_PERSON_ID);
export const ORG_ID = "7412903";
export const ORG_URN = organizationUrn(ORG_ID);

/** Anchor: Monday 2026-07-27, the same week the seed uses. */
export const MONDAY = { year: 2026, month: 7, day: 27 };

export function at(dayOffset: number, hour: number, minute = 0): number {
  return Date.UTC(MONDAY.year, MONDAY.month - 1, MONDAY.day + dayOffset, hour, minute);
}

interface TestMember {
  id: string;
  email: string;
  givenName: string;
  familyName: string;
}

const CAST: TestMember[] = [
  { id: OWNER_PERSON_ID, email: OWNER_EMAIL, givenName: "Sandbox", familyName: "User" },
  { id: "dK7mQv2XbT", email: "priya@acme.co", givenName: "Priya", familyName: "Nair" },
  { id: "pR4nLz8YcW", email: "dan@acme.co", givenName: "Dan", familyName: "Okafor" },
  { id: "mB9tGx3JdV", email: "mei@acme.co", givenName: "Mei", familyName: "Lin" },
  { id: "xF5cNr7QsE", email: "j.rivera@example.com", givenName: "Jordan", familyName: "Rivera" },
];

export const PRIYA_URN = personUrn("dK7mQv2XbT");
export const DAN_URN = personUrn("pR4nLz8YcW");
export const MEI_URN = personUrn("mB9tGx3JdV");
export const JORDAN_URN = personUrn("xF5cNr7QsE");

export interface TestReaction {
  actorUrn: string;
  type?: string;
}

export interface TestComment {
  id: string;
  actorUrn: string;
  agentUrn?: string;
  text: string;
  atMs: number;
  parentId?: string;
  reactions?: TestReaction[];
}

export interface TestPost {
  id: string;
  authorUrn?: string;
  commentary?: string;
  lifecycleState?: "PUBLISHED" | "DRAFT";
  commentsState?: "OPEN" | "CLOSED";
  createdMs: number;
  publishedMs?: number | null;
  lastModifiedMs?: number;
  extra?: Record<string, unknown>;
  comments?: TestComment[];
  reactions?: TestReaction[];
}

export function makeTestDb(posts: TestPost[] = []): Database.Database {
  const db = new Database(":memory:");
  db.exec(schema);
  // Mirror production's ATTACHed audit.db so mutation code paths that log can
  // run unchanged under test.
  db.prepare("ATTACH DATABASE ':memory:' AS audit").run();
  db.exec(AUDIT_DDL);

  setMeta(db, "owner_person_id", OWNER_PERSON_ID);
  setMeta(db, "organization_id", ORG_ID);

  for (const member of CAST) {
    insertMember(db, { ...member, isOwner: member.id === OWNER_PERSON_ID });
  }
  insertOrganization(db, { id: ORG_ID, name: "Acme", vanityName: "acme-co" });
  insertAcl(db, { organizationId: ORG_ID, memberId: OWNER_PERSON_ID });

  for (const post of posts) {
    const isDraft = post.lifecycleState === "DRAFT";
    insertPost(db, {
      id: post.id,
      authorUrn: post.authorUrn ?? ORG_URN,
      commentary: post.commentary ?? "",
      lifecycleState: post.lifecycleState ?? "PUBLISHED",
      commentsState: post.commentsState ?? "OPEN",
      createdMs: post.createdMs,
      publishedMs: post.publishedMs === undefined ? (isDraft ? null : post.createdMs) : post.publishedMs,
      lastModifiedMs: post.lastModifiedMs ?? post.createdMs,
      extra: post.extra,
      isSandboxCreated: false,
    });
    for (const comment of post.comments ?? []) {
      insertComment(db, {
        id: comment.id,
        postId: post.id,
        parentCommentId: comment.parentId ?? null,
        actorUrn: comment.actorUrn,
        agentUrn: comment.agentUrn ?? null,
        text: comment.text,
        createdMs: comment.atMs,
        isSandboxCreated: false,
      });
      for (const reaction of comment.reactions ?? []) {
        upsertReaction(db, {
          actorUrn: reaction.actorUrn,
          entityUrn: commentUrn(post.id, comment.id),
          reactionType: reaction.type ?? "LIKE",
          createdMs: comment.atMs + 60_000,
          isSandboxCreated: false,
        });
      }
    }
    for (const reaction of post.reactions ?? []) {
      upsertReaction(db, {
        actorUrn: reaction.actorUrn,
        entityUrn: activityUrn(post.id),
        reactionType: reaction.type ?? "LIKE",
        createdMs: post.createdMs + 60_000,
        isSandboxCreated: false,
      });
    }
  }
  return db;
}

export const POST_BUSY = "7487797749352832044";
export const POST_QUIET = "7488533849704438922";
export const POST_PERSONAL = "7487424036866974459";
export const POST_DRAFT = "7488996900865953560";
export const COMMENT_JORDAN = "7487809828949811964";
export const COMMENT_PAGE_REPLY = "7487823670150563750";

/**
 * Four posts, reused across every suite: one busy company post with a reply and
 * mixed reactions, one with no engagement at all (the finder-returns-404 case),
 * one personal post by the owner, and one DRAFT.
 */
export const CORPUS: TestPost[] = [
  {
    id: POST_BUSY,
    commentary: "Post-mortem: the ingest queue was unavailable for 94 minutes on Friday.",
    createdMs: at(1, 9, 15),
    lastModifiedMs: at(1, 9, 15),
    reactions: [
      { actorUrn: PRIYA_URN, type: "LIKE" },
      { actorUrn: DAN_URN, type: "LIKE" },
      { actorUrn: MEI_URN, type: "PRAISE" },
      { actorUrn: JORDAN_URN, type: "EMPATHY" },
    ],
    comments: [
      {
        id: COMMENT_JORDAN,
        actorUrn: JORDAN_URN,
        text: "What is the escalation path for named accounts?",
        atMs: at(1, 10, 3),
        reactions: [
          { actorUrn: PRIYA_URN },
          { actorUrn: DAN_URN },
          { actorUrn: MEI_URN },
          { actorUrn: OWNER_URN },
        ],
      },
      {
        id: COMMENT_PAGE_REPLY,
        actorUrn: ORG_URN,
        agentUrn: OWNER_URN,
        text: "Named accounts are paged directly — we missed that and it is fixed.",
        atMs: at(1, 10, 58),
        parentId: COMMENT_JORDAN,
      },
    ],
  },
  {
    id: POST_QUIET,
    commentary: "Release 4.3 ships today.",
    createdMs: at(3, 10),
    lastModifiedMs: at(3, 10),
  },
  {
    id: POST_PERSONAL,
    authorUrn: OWNER_URN,
    commentary: "Three years at Acme today.",
    createdMs: at(0, 8, 30),
    lastModifiedMs: at(0, 8, 30),
    commentsState: "CLOSED",
  },
  {
    id: POST_DRAFT,
    commentary: "Q3 numbers are in and…",
    lifecycleState: "DRAFT",
    createdMs: at(4, 16, 40),
    lastModifiedMs: at(4, 16, 40),
  },
];
