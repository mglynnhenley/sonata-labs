import type { Database } from "better-sqlite3";
import { activityUrn, commentUrn, organizationUrn, personUrn } from "./linkedin/urn";
import { insertComment } from "./store/comments";
import { insertMember } from "./store/members";
import { setMeta } from "./store/meta";
import { insertAcl, insertOrganization } from "./store/organizations";
import { insertPost } from "./store/posts";
import { upsertReaction } from "./store/reactions";

// The synthetic demo world, so the clone runs with no orchestrator and no real
// LinkedIn account.
//
// It deliberately shares people, domains and the anchor week with the Gmail,
// Slack and Calendar seeds (sandbox.user@gmail.com, priya@acme.co, Acme, the
// week of Monday 2026-07-27) so a cloned business is coherent across four
// surfaces. A clone seeded with its own invented people is a fourth fixture,
// not a fourth surface.
//
// Everything below is a literal — ids included — because the demo seed has to be
// byte-identical run to run, and a test that names a post by id is worth more
// than one that finds it by scanning.

export const OWNER_EMAIL = "sandbox.user@gmail.com";
export const OWNER_PERSON_ID = "sHq2WpRk9L";
export const OWNER_URN = personUrn(OWNER_PERSON_ID);
export const ORG_ID = "7412903";
export const ORG_NAME = "Acme";
export const ORG_VANITY = "acme-co";
export const ORG_URN = organizationUrn(ORG_ID);

/** Anchor to a fixed week so seeds are reproducible run-to-run. Mon 2026-07-27. */
export const WEEK_MONDAY = { year: 2026, month: 7, day: 27 };

/** UTC instant on the anchor Monday + dayOffset. */
function at(dayOffset: number, hour: number, minute = 0): number {
  return Date.UTC(WEEK_MONDAY.year, WEEK_MONDAY.month - 1, WEEK_MONDAY.day + dayOffset, hour, minute);
}

/** The sentinel an author/actor uses to mean the company page rather than a person. */
const PAGE = "@page";

interface SeedMember {
  email: string;
  personId: string;
  givenName: string;
  familyName: string;
  /** APPROVED ADMINISTRATOR on the page unless `aclState` says otherwise. */
  acl?: "APPROVED" | "REQUESTED";
}

// Four Acme people (the cast the other three clones seed) and eight members of
// the public who follow the page. The followers exist because reactions on a
// company post come from outside the company: one reaction per member per entity
// is LinkedIn's rule and this table's primary key, so a four-person cast could
// never produce a post with double-digit engagement.
const MEMBERS: SeedMember[] = [
  {
    email: OWNER_EMAIL,
    personId: OWNER_PERSON_ID,
    givenName: "Sandbox",
    familyName: "User",
    acl: "APPROVED",
  },
  {
    email: "priya@acme.co",
    personId: "dK7mQv2XbT",
    givenName: "Priya",
    familyName: "Nair",
    acl: "APPROVED",
  },
  {
    email: "dan@acme.co",
    personId: "pR4nLz8YcW",
    givenName: "Dan",
    familyName: "Okafor",
    // Asked for page access and has not been granted it — so `state=APPROVED`
    // on the ACL finder is a filter that actually removes a row, and Dan is a
    // real answer to "who may post as the page" being no.
    acl: "REQUESTED",
  },
  {
    email: "mei@acme.co",
    personId: "mB9tGx3JdV",
    givenName: "Mei",
    familyName: "Lin",
  },
  {
    email: "j.rivera@example.com",
    personId: "xF5cNr7QsE",
    givenName: "Jordan",
    familyName: "Rivera",
  },
  {
    email: "t.alvarez@example.com",
    personId: "hQ2wKp6RtN",
    givenName: "Tom",
    familyName: "Alvarez",
  },
  {
    email: "s.okonkwo@example.com",
    personId: "vG8yUb4MzL",
    givenName: "Sade",
    familyName: "Okonkwo",
  },
  {
    email: "l.haddad@example.com",
    personId: "cN3sJe9WqA",
    givenName: "Layla",
    familyName: "Haddad",
  },
  {
    email: "m.novak@example.com",
    personId: "tY6dFh1XpB",
    givenName: "Marek",
    familyName: "Novak",
  },
  {
    email: "a.chen@example.com",
    personId: "zR7kLm2VnD",
    givenName: "Alice",
    familyName: "Chen",
  },
  {
    email: "p.dubois@example.com",
    personId: "bW4gQt8YsC",
    givenName: "Paul",
    familyName: "Dubois",
  },
  {
    email: "e.mensah@example.com",
    personId: "nJ5vCx3HkF",
    givenName: "Esi",
    familyName: "Mensah",
  },
];

const URN_BY_EMAIL = new Map(MEMBERS.map((m) => [m.email, personUrn(m.personId)]));

function actorUrn(actor: string): string {
  if (actor === PAGE) return ORG_URN;
  const urn = URN_BY_EMAIL.get(actor);
  if (!urn) throw new Error(`seed references ${actor}, who is not in MEMBERS`);
  return urn;
}

interface SeedReaction {
  actor: string;
  type: "LIKE" | "PRAISE" | "EMPATHY" | "INTEREST" | "APPRECIATION" | "ENTERTAINMENT";
  /** Minutes after the thing it reacts to — engagement arrives over a day. */
  after: number;
}

interface SeedComment {
  id: string;
  actor: string;
  text: string;
  atMs: number;
  replies?: SeedComment[];
  reactions?: SeedReaction[];
}

interface SeedPost {
  id: string;
  author: string;
  commentary: string;
  publishedMs: number;
  lifecycleState?: "PUBLISHED" | "DRAFT";
  commentsState?: "OPEN" | "CLOSED";
  comments?: SeedComment[];
  reactions?: SeedReaction[];
}

// Exported so tests and the smoke script can name a post rather than guess one.
export const POST_HIRING = "7482358156494640766";
export const POST_CUSTOMER_STORY = "7483520817561872351";
export const POST_PERSONAL = "7487424036866974459";
export const POST_POSTMORTEM = "7487797749352832044";
export const POST_CONFERENCE = "7488186561333991157";
export const POST_RELEASE = "7488533849704438922";
export const POST_DRAFT = "7488996900865953560";

/** Jordan's question on the post-mortem: the one comment nobody has answered. */
export const COMMENT_JORDAN = "7487809828949811964";

const POSTS: SeedPost[] = [
  {
    id: POST_HIRING,
    author: OWNER_EMAIL,
    commentary:
      "We are hiring two support engineers at Acme. If you like the part of the job where " +
      "you actually find out what went wrong, come talk to us. Links in the comments.",
    publishedMs: at(-14, 9),
    reactions: [
      { actor: "priya@acme.co", type: "LIKE", after: 22 },
      { actor: "dan@acme.co", type: "LIKE", after: 35 },
      { actor: "mei@acme.co", type: "PRAISE", after: 61 },
      { actor: "a.chen@example.com", type: "LIKE", after: 74 },
      { actor: "l.haddad@example.com", type: "LIKE", after: 140 },
      { actor: "e.mensah@example.com", type: "PRAISE", after: 300 },
    ],
    comments: [
      {
        id: "7482378289156123266",
        actor: "a.chen@example.com",
        text: "Sent this to two people this morning. Good team to land on.",
        atMs: at(-14, 10, 20),
      },
      {
        id: "7482419812762232211",
        actor: "priya@acme.co",
        text: "Happy to answer anything about the support side — my inbox is open.",
        atMs: at(-14, 13, 5),
      },
      {
        id: "7482730610688031184",
        actor: "e.mensah@example.com",
        text: "Is the second role remote-friendly?",
        atMs: at(-13, 9, 40),
      },
    ],
  },
  {
    id: POST_CUSTOMER_STORY,
    author: PAGE,
    commentary:
      "Lumen Freight cut first-response time from nine hours to under forty minutes after " +
      "moving their support desk onto Acme. The whole migration ran over one weekend.",
    publishedMs: at(-11, 14),
    reactions: [
      { actor: "t.alvarez@example.com", type: "LIKE", after: 18 },
      { actor: "m.novak@example.com", type: "PRAISE", after: 55 },
      { actor: "s.okonkwo@example.com", type: "LIKE", after: 90 },
      { actor: "priya@acme.co", type: "LIKE", after: 120 },
      { actor: "p.dubois@example.com", type: "INTEREST", after: 400 },
    ],
    comments: [
      {
        id: "7483538433641639369",
        actor: "t.alvarez@example.com",
        text: "Glad to be part of this. The migration weekend was quieter than we expected.",
        atMs: at(-11, 15, 10),
      },
      {
        id: "7483806449667484878",
        actor: "mei@acme.co",
        text: "Credit to the implementation team — they rehearsed the cutover three times.",
        atMs: at(-10, 8, 55),
      },
    ],
  },
  {
    id: POST_PERSONAL,
    author: OWNER_EMAIL,
    commentary:
      "Three years at Acme today. Still the only place I have worked where the incident " +
      "review is the calmest meeting of the week.",
    publishedMs: at(0, 8, 30),
    // The author turned comments off once the congratulations had rolled in —
    // which is what makes the "commentsState: CLOSED" refusal on comment create
    // a state the seed can actually reach.
    commentsState: "CLOSED",
    reactions: [
      { actor: "priya@acme.co", type: "PRAISE", after: 12 },
      { actor: "dan@acme.co", type: "LIKE", after: 25 },
      { actor: "mei@acme.co", type: "PRAISE", after: 40 },
      { actor: "l.haddad@example.com", type: "LIKE", after: 95 },
      { actor: "t.alvarez@example.com", type: "LIKE", after: 130 },
      { actor: "e.mensah@example.com", type: "LIKE", after: 210 },
      { actor: "p.dubois@example.com", type: "LIKE", after: 320 },
    ],
    comments: [
      {
        id: "7487434606510307389",
        actor: "priya@acme.co",
        text: "Three years of unreasonably calm incident calls. Congratulations.",
        atMs: at(0, 9, 12),
      },
      {
        id: "7487457759068878898",
        actor: "dan@acme.co",
        text: "Congrats — still the fastest triage in the building.",
        atMs: at(0, 10, 44),
      },
    ],
  },
  {
    // The flagship. Uneven engagement is the point: "check the engagement on a
    // post" has a right answer and a wrong one, and "answer the comments" has an
    // obvious first target — Jordan's, which nobody has replied to.
    id: POST_POSTMORTEM,
    author: PAGE,
    commentary:
      "Post-mortem: on Friday our ingest queue was unavailable for 94 minutes. A schema " +
      "migration held a lock that a retry storm then made permanent. We have published the " +
      "timeline, the root cause and the three changes we are making, including per-tenant " +
      "retry limits. We are sorry — this one was ours.",
    publishedMs: at(1, 9, 15),
    reactions: [
      { actor: "priya@acme.co", type: "LIKE", after: 8 },
      { actor: "dan@acme.co", type: "LIKE", after: 14 },
      { actor: "mei@acme.co", type: "LIKE", after: 21 },
      { actor: "t.alvarez@example.com", type: "PRAISE", after: 33 },
      { actor: "s.okonkwo@example.com", type: "PRAISE", after: 47 },
      { actor: "m.novak@example.com", type: "EMPATHY", after: 62 },
      { actor: "l.haddad@example.com", type: "LIKE", after: 88 },
      { actor: "e.mensah@example.com", type: "EMPATHY", after: 115 },
      { actor: "p.dubois@example.com", type: "INTEREST", after: 190 },
      { actor: "a.chen@example.com", type: "LIKE", after: 240 },
      { actor: "j.rivera@example.com", type: "INTEREST", after: 305 },
    ],
    comments: [
      {
        id: "7487804544124913647",
        actor: "t.alvarez@example.com",
        text: "Thank you for publishing this. The timeline detail is more than most companies share.",
        atMs: at(1, 9, 42),
        reactions: [
          { actor: "priya@acme.co", type: "LIKE", after: 15 },
          { actor: "dan@acme.co", type: "LIKE", after: 40 },
        ],
      },
      {
        id: COMMENT_JORDAN,
        actor: "j.rivera@example.com",
        text:
          "Jordan here, ops at Northwind. We were down the full 94 minutes on our side and " +
          "nobody from Acme called us. What is the escalation path for named accounts?",
        atMs: at(1, 10, 3),
        // Four likers, so a reader has to see the selectedLikes preview cap.
        reactions: [
          { actor: "p.dubois@example.com", type: "LIKE", after: 20 },
          { actor: "e.mensah@example.com", type: "LIKE", after: 55 },
          { actor: "l.haddad@example.com", type: "LIKE", after: 96 },
          { actor: "m.novak@example.com", type: "LIKE", after: 180 },
        ],
      },
      {
        id: "7487815617087151493",
        actor: "s.okonkwo@example.com",
        text: "The retry storm matches what we saw from outside. Are the new limits documented publicly?",
        atMs: at(1, 10, 26),
        replies: [
          {
            id: "7487823670150563750",
            actor: PAGE,
            text:
              "They are — the per-tenant limits went into the changelog this morning, and the " +
              "retry guidance is in the SDK release notes.",
            atMs: at(1, 10, 58),
          },
        ],
      },
      {
        id: "7487826186735405018",
        actor: "m.novak@example.com",
        text: "Respect for naming the root cause instead of blaming an upstream provider.",
        atMs: at(1, 11, 8),
      },
      {
        id: "7487847074369516555",
        actor: "l.haddad@example.com",
        text: "Any plan to let us subscribe to status updates per account rather than globally?",
        atMs: at(1, 12, 31),
        replies: [
          {
            id: "7487889604609705447",
            actor: "mei@acme.co",
            text: "Per-account subscriptions are on the Q4 roadmap. I will follow up here with a date.",
            atMs: at(1, 15, 20),
          },
        ],
      },
      {
        id: "7487869975266964200",
        actor: "e.mensah@example.com",
        text: "We are writing our own post-mortem template this quarter. Mind if we borrow the structure?",
        atMs: at(1, 14, 2),
      },
      {
        id: "7487910995560762625",
        actor: "p.dubois@example.com",
        text: "94 minutes is the number that will get quoted. What is the target for next time?",
        atMs: at(1, 16, 45),
      },
    ],
  },
  {
    id: POST_CONFERENCE,
    author: PAGE,
    commentary:
      "We will be at LogiCon in Rotterdam next month. Priya is giving the Thursday talk on " +
      "running a support desk that does not need a war room.",
    publishedMs: at(2, 11),
    reactions: [
      { actor: "mei@acme.co", type: "LIKE", after: 30 },
      { actor: "dan@acme.co", type: "LIKE", after: 95 },
    ],
    comments: [
      {
        id: "7488205435699926420",
        actor: "a.chen@example.com",
        text: "Booth as well, or just the talk?",
        atMs: at(2, 12, 15),
      },
    ],
  },
  {
    // No comments at all, deliberately: the socialActions comments finder
    // answers 404 for a thread with none, and an agent has to meet that here as
    // it would at LinkedIn.
    id: POST_RELEASE,
    author: PAGE,
    commentary:
      "Release 4.3 ships today: per-tenant retry limits, a faster bulk importer, and " +
      "audit exports that no longer time out at 100k rows.",
    publishedMs: at(3, 10),
    reactions: [
      { actor: "s.okonkwo@example.com", type: "LIKE", after: 45 },
      { actor: "t.alvarez@example.com", type: "LIKE", after: 110 },
      { actor: "priya@acme.co", type: "PRAISE", after: 260 },
    ],
  },
  {
    // The draft the owner started and never published. It is the reason
    // lifecycleState DRAFT -> PUBLISHED via PARTIAL_UPDATE is a real task here
    // rather than a theoretical one.
    id: POST_DRAFT,
    author: PAGE,
    commentary:
      "Q3 numbers are in and the support desk handled 41% more volume with the same team. " +
      "Full write-up next week.",
    publishedMs: at(4, 16, 40),
    lifecycleState: "DRAFT",
  },
];

export function seedDatabase(db: Database): void {
  // The two keys the API reads, and only those: meta is a lookup table, not a
  // manifest. A key nothing reads back is a fact about the world that no route
  // can be wrong about, which makes it indistinguishable from one that drifted.
  setMeta(db, "owner_person_id", OWNER_PERSON_ID);
  setMeta(db, "organization_id", ORG_ID);

  for (const member of MEMBERS) {
    insertMember(db, {
      id: member.personId,
      email: member.email,
      givenName: member.givenName,
      familyName: member.familyName,
      pictureUrl:
        member.email === OWNER_EMAIL
          ? "https://media.licdn.com/dms/image/v2/D4E03AQFsandboxuser/profile-displayphoto-shrink_400_400/0/1753612800000"
          : null,
      isOwner: member.email === OWNER_EMAIL,
    });
  }

  insertOrganization(db, { id: ORG_ID, name: ORG_NAME, vanityName: ORG_VANITY });
  for (const member of MEMBERS) {
    if (member.acl) {
      insertAcl(db, { organizationId: ORG_ID, memberId: member.personId, state: member.acl });
    }
  }

  const writeReactions = (entityUrn: string, baseMs: number, reactions?: SeedReaction[]): void => {
    for (const reaction of reactions ?? []) {
      upsertReaction(db, {
        actorUrn: actorUrn(reaction.actor),
        entityUrn,
        reactionType: reaction.type,
        createdMs: baseMs + reaction.after * 60_000,
        isSandboxCreated: false,
      });
    }
  };

  const writeComment = (postId: string, comment: SeedComment, parentId: string | null): void => {
    insertComment(db, {
      id: comment.id,
      postId,
      parentCommentId: parentId,
      actorUrn: actorUrn(comment.actor),
      // A page never comments on its own: LinkedIn records the admin who did.
      agentUrn: comment.actor === PAGE ? OWNER_URN : null,
      text: comment.text,
      createdMs: comment.atMs,
      isSandboxCreated: false,
    });
    writeReactions(commentUrn(postId, comment.id), comment.atMs, comment.reactions);
    for (const reply of comment.replies ?? []) writeComment(postId, reply, comment.id);
  };

  for (const post of POSTS) {
    const isDraft = post.lifecycleState === "DRAFT";
    insertPost(db, {
      id: post.id,
      authorUrn: actorUrn(post.author),
      commentary: post.commentary,
      lifecycleState: post.lifecycleState ?? "PUBLISHED",
      commentsState: post.commentsState ?? "OPEN",
      createdMs: post.publishedMs,
      publishedMs: isDraft ? null : post.publishedMs,
      lastModifiedMs: post.publishedMs,
      isSandboxCreated: false,
    });
    for (const comment of post.comments ?? []) writeComment(post.id, comment, null);
    writeReactions(activityUrn(post.id), post.publishedMs, post.reactions);
  }
}
