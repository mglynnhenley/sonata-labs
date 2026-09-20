// The LinkedIn twin's half of the seed contract. The contract itself is written
// out in full at the top of packages/world/src/inject.ts; these are the shapes
// that arrive on the wire.
//
// Deliberately NOT typed against @sonata/core: a twin is a standalone app that
// must run (and be tested) with no orchestrator installed. Everything below is
// structurally compatible with the orchestrator's shapes, and that compatibility
// is the contract.

/** Structurally core's `Person`. Only the fields this twin actually reads. */
export interface WirePerson {
  id: string;
  name: string;
  email: string;
}

/** Structurally core's `WorldSeed`. The cast is what makes the clone coherent. */
export interface WireWorld {
  business: { name: string };
  cast: WirePerson[];
  mailboxOwner: string;
  timezone?: string;
}

/**
 * A cast member's LinkedIn identity. `email` is the join key and the only field
 * shared with the other twins — a person can be in the world without being on
 * LinkedIn, but they cannot post there without a person id.
 */
export interface LinkedInWireMember {
  email: string;
  personId: string;
  /** Whether this member may act as the company page. The owner always may. */
  pageAdmin?: boolean;
}

export interface LinkedInWireOrganization {
  id: string;
  name: string;
  vanityName: string;
}

export type LinkedInWireReactionType =
  | "LIKE"
  | "PRAISE"
  | "EMPATHY"
  | "INTEREST"
  | "APPRECIATION"
  | "ENTERTAINMENT";

export interface LinkedInWireReaction {
  actorEmail: string;
  reactionType: LinkedInWireReactionType;
  createdISO: string;
}

export interface LinkedInWireComment {
  id: string;
  /** Same two-field shape as a post's author, and for the same reason: a page
   *  can have replied to its own thread before the agent ever arrived. */
  actorKind: "organization" | "member";
  actorEmail?: string;
  text: string;
  createdISO: string;
  /** One level only — that is all the socialActions comments-on-comments path needs. */
  replies?: LinkedInWireComment[];
  reactions?: LinkedInWireReaction[];
}

/**
 * `authorKind` and `authorEmail` are two fields rather than one union-shaped
 * string, because `"organization" | <some email>` erases to `string` and leaves
 * the parser unable to tell the sentinel from a typo'd address.
 */
export interface LinkedInWirePost {
  id: string;
  authorKind: "organization" | "member";
  authorEmail?: string;
  commentary: string;
  visibility: "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";
  lifecycleState: "PUBLISHED" | "DRAFT";
  publishedISO: string;
  commentsState?: "OPEN" | "CLOSED";
  comments?: LinkedInWireComment[];
  reactions?: LinkedInWireReaction[];
}

export interface LinkedInWireSeed {
  world: WireWorld;
  /** The instant every relative offset in the source seed was resolved against. */
  nowISO: string;
  /** Make the seeded state the one `reset` returns to. Absent means no. */
  promoteToSnapshot?: boolean;
  ownerEmail: string;
  organization: LinkedInWireOrganization;
  members: LinkedInWireMember[];
  posts: LinkedInWirePost[];
}

export interface SeedRequest {
  twin: "linkedin";
  seed: LinkedInWireSeed;
}

/** `counts` is what was actually written, read back out of the DB. Declared
 *  inline rather than imported from ../store/counts so the wire contract keeps
 *  depending on nothing. */
export interface SeedResult {
  ok: true;
  counts: {
    members: number;
    organizations: number;
    posts: number;
    comments: number;
    reactions: number;
  };
}

// ---------------------------------------------------------------------------
// Validated form. Parsing turns the wire into exactly this and nothing else, so
// the writer cannot see an unchecked string or an unparsed timestamp.
// ---------------------------------------------------------------------------

export interface ParsedMember {
  personId: string;
  email: string;
  givenName: string;
  familyName: string;
  pageAdmin: boolean;
}

export interface ParsedOrganization {
  id: string;
  name: string;
  vanityName: string;
}

export interface ParsedReaction {
  actorUrn: string;
  reactionType: string;
  createdMs: number;
}

export interface ParsedComment {
  id: string;
  actorUrn: string;
  /** The admin who acted, when the actor is the page. */
  agentUrn: string | null;
  text: string;
  createdMs: number;
  parentCommentId: string | null;
  reactions: ParsedReaction[];
}

export interface ParsedPost {
  id: string;
  authorUrn: string;
  commentary: string;
  visibility: string;
  lifecycleState: string;
  commentsState: string;
  createdMs: number;
  publishedMs: number | null;
  comments: ParsedComment[];
  reactions: ParsedReaction[];
}

export interface ParsedSeed {
  nowMs: number;
  /** Resolved by matching ownerEmail against members[].personId — the owner has
   *  to have a LinkedIn identity, because every write is attributed to it. */
  ownerPersonId: string;
  businessName: string;
  promoteToSnapshot: boolean;
  organization: ParsedOrganization;
  members: ParsedMember[];
  posts: ParsedPost[];
}
