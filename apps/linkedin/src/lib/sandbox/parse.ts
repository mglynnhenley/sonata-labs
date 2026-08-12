import { organizationUrn, personUrn } from "../linkedin/urn";
import type {
  ParsedComment,
  ParsedMember,
  ParsedOrganization,
  ParsedPost,
  ParsedReaction,
  ParsedSeed,
  WirePerson,
} from "./types";

// Validating a cloned business on the way in. Everything here fails loudly with
// a message that names the offending path and says what to fix: a seed that is
// half-understood produces a company page the agent quietly reasons about
// wrongly, which is far worse than a run that refuses to start.
//
// The one rule doing real work is cast membership. A twin must never invent an
// identity — "Priya who commented on the post-mortem" is only the same person as
// "Priya in the inbox" because both came out of `world.cast` — so an author or a
// commenter the world has never heard of is a 400, not a new member.

export class BadRequestError extends Error {}

const VISIBILITIES = ["PUBLIC", "CONNECTIONS", "LOGGED_IN"];
const LIFECYCLE_STATES = ["PUBLISHED", "DRAFT"];
const COMMENTS_STATES = ["OPEN", "CLOSED"];
const REACTION_TYPES = [
  "LIKE",
  "PRAISE",
  "EMPATHY",
  "INTEREST",
  "APPRECIATION",
  "ENTERTAINMENT",
];

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestError(`${where} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function array(source: Record<string, unknown>, key: string, where: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new BadRequestError(`${where}.${key} must be an array`);
  return value;
}

/** For the list fields a hand-written seed reasonably leaves off entirely. */
function optionalArray(source: Record<string, unknown>, key: string, where: string): unknown[] {
  return source[key] === undefined || source[key] === null ? [] : array(source, key, where);
}

function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestError(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

/** Absent, null and "" all mean "no value" for the optional prose fields. */
function optionalText(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new BadRequestError(`${where}.${key} must be a string`);
  return value;
}

function instant(source: Record<string, unknown>, key: string, where: string): number {
  const raw = text(source, key, where);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new BadRequestError(
      `${where}.${key} must be an absolute ISO 8601 timestamp, got "${raw}"`,
    );
  }
  return ms;
}

function oneOf(
  source: Record<string, unknown>,
  key: string,
  where: string,
  allowed: string[],
): string {
  const value = text(source, key, where);
  if (!allowed.includes(value)) {
    throw new BadRequestError(`${where}.${key} must be one of ${allowed.join(", ")}, got "${value}"`);
  }
  return value;
}

/** LinkedIn ids are decimal strings; anything else breaks every URN built from it. */
function decimalId(source: Record<string, unknown>, key: string, where: string): string {
  const value = text(source, key, where);
  if (!/^\d+$/.test(value)) {
    throw new BadRequestError(`${where}.${key} "${value}" must be a decimal id, digits only`);
  }
  return value;
}

function castOf(world: Record<string, unknown>): WirePerson[] {
  return array(world, "cast", "seed.world").map((entry, i) => {
    const where = `seed.world.cast[${i}]`;
    const person = object(entry, where);
    return {
      id: text(person, "id", where),
      name: text(person, "name", where),
      email: text(person, "email", where),
    };
  });
}

/** The cast carries one `name`; members has two columns. Split on the first space. */
function splitName(name: string): { givenName: string; familyName: string } {
  const cut = name.indexOf(" ");
  return cut === -1
    ? { givenName: name, familyName: "" }
    : { givenName: name.slice(0, cut), familyName: name.slice(cut + 1) };
}

function parseMembers(entries: unknown[], cast: Map<string, string>): ParsedMember[] {
  const emails = new Set<string>();
  const personIds = new Set<string>();
  return entries.map((entry, i) => {
    const where = `seed.members[${i}]`;
    const raw = object(entry, where);
    const email = text(raw, "email", where);
    const key = email.toLowerCase();
    const name = cast.get(key);
    if (name === undefined) {
      throw new BadRequestError(
        `${where}.email "${email}" is not in seed.world.cast — every LinkedIn member must ` +
          `come from the one cast, so add them to it rather than to LinkedIn alone`,
      );
    }
    if (emails.has(key)) {
      throw new BadRequestError(`seed.members lists "${email}" twice`);
    }
    emails.add(key);

    const personId = text(raw, "personId", where);
    if (personIds.has(personId)) {
      throw new BadRequestError(`seed.members reuses personId "${personId}" for two people`);
    }
    personIds.add(personId);

    const pageAdmin = raw.pageAdmin;
    if (pageAdmin !== undefined && typeof pageAdmin !== "boolean") {
      throw new BadRequestError(`${where}.pageAdmin must be a boolean when present`);
    }

    return {
      personId,
      email,
      ...splitName(name),
      headline: optionalText(raw, "headline", where),
      vanityName: optionalText(raw, "vanityName", where),
      pageAdmin: pageAdmin === true,
    };
  });
}

/** Everything an author/actor/reactor email is resolved through. */
interface Directory {
  /** lowercased email -> person URN */
  urnByEmail: Map<string, string>;
  organizationUrn: string;
  ownerUrn: string;
}

function actorUrnOf(
  raw: Record<string, unknown>,
  where: string,
  dir: Directory,
  kindKey: string,
  emailKey: string,
): { urn: string; agentUrn: string | null } {
  const kind = oneOf(raw, kindKey, where, ["organization", "member"]);
  if (kind === "organization") {
    // A page never acts on its own: LinkedIn records the admin who did, and the
    // clone carries that through as `agent` on the comment.
    return { urn: dir.organizationUrn, agentUrn: dir.ownerUrn };
  }
  const email = text(raw, emailKey, where);
  const urn = dir.urnByEmail.get(email.toLowerCase());
  if (!urn) {
    throw new BadRequestError(
      `${where}.${emailKey} "${email}" has no seed.members entry — a person can be in the ` +
        `world without being on LinkedIn, but they cannot post there without a person id`,
    );
  }
  return { urn, agentUrn: null };
}

function parseReactions(
  entries: unknown[],
  where: string,
  dir: Directory,
): ParsedReaction[] {
  const seen = new Set<string>();
  return entries.map((entry, i) => {
    const at = `${where}.reactions[${i}]`;
    const raw = object(entry, at);
    const email = text(raw, "actorEmail", at);
    const urn = dir.urnByEmail.get(email.toLowerCase());
    if (!urn) {
      throw new BadRequestError(
        `${at}.actorEmail "${email}" has no seed.members entry — every reactor must be a ` +
          `cast member with a LinkedIn identity`,
      );
    }
    if (seen.has(urn)) {
      // One reaction per member per entity is LinkedIn's rule and the table's
      // primary key, so a second one would silently overwrite the first and the
      // seed's own counts would not match what it wrote.
      throw new BadRequestError(`${at}.actorEmail "${email}" reacts to the same entity twice`);
    }
    seen.add(urn);

    const type = text(raw, "reactionType", at);
    if (!REACTION_TYPES.includes(type)) {
      throw new BadRequestError(
        type === "MAYBE"
          ? `${at}.reactionType MAYBE was deprecated in LinkedIn version 202307 and now 400s; ` +
            `use one of ${REACTION_TYPES.join(", ")}`
          : `${at}.reactionType must be one of ${REACTION_TYPES.join(", ")}, got "${type}"`,
      );
    }
    return { actorUrn: urn, reactionType: type, createdMs: instant(raw, "createdISO", at) };
  });
}

function parseComments(
  entries: unknown[],
  where: string,
  dir: Directory,
  ids: Set<string>,
  parentCommentId: string | null,
): ParsedComment[] {
  return entries.flatMap((entry, i) => {
    const at = `${where}.comments[${i}]`;
    const raw = object(entry, at);
    const id = decimalId(raw, "id", at);
    if (ids.has(id)) throw new BadRequestError(`seed has two comments with id "${id}"`);
    ids.add(id);

    const { urn, agentUrn } = actorUrnOf(raw, at, dir, "actorKind", "actorEmail");
    const comment: ParsedComment = {
      id,
      actorUrn: urn,
      agentUrn,
      text: text(raw, "text", at),
      createdMs: instant(raw, "createdISO", at),
      parentCommentId,
      reactions: parseReactions(optionalArray(raw, "reactions", at), at, dir),
    };

    const replies = optionalArray(raw, "replies", at);
    if (replies.length && parentCommentId !== null) {
      throw new BadRequestError(
        `${at}.replies nests a second level — LinkedIn's comment threads are one level deep`,
      );
    }
    return [comment, ...parseComments(replies, at, dir, ids, id)];
  });
}

function parsePosts(entries: unknown[], dir: Directory): ParsedPost[] {
  const postIds = new Set<string>();
  const commentIds = new Set<string>();

  return entries.map((entry, i) => {
    const where = `seed.posts[${i}]`;
    const raw = object(entry, where);
    const id = decimalId(raw, "id", where);
    if (postIds.has(id)) throw new BadRequestError(`seed.posts has two posts with id "${id}"`);
    postIds.add(id);

    const { urn } = actorUrnOf(raw, where, dir, "authorKind", "authorEmail");
    const lifecycleState = oneOf(raw, "lifecycleState", where, LIFECYCLE_STATES);
    const authoredMs = instant(raw, "publishedISO", where);
    const comments = parseComments(
      optionalArray(raw, "comments", where),
      where,
      dir,
      commentIds,
      null,
    );
    const reactions = parseReactions(optionalArray(raw, "reactions", where), where, dir);

    if (lifecycleState === "DRAFT" && (comments.length || reactions.length)) {
      throw new BadRequestError(
        `${where} is a DRAFT but carries engagement — nobody can comment on or react to a ` +
          `post that was never published`,
      );
    }

    return {
      id,
      authorUrn: urn,
      commentary: optionalText(raw, "commentary", where),
      visibility: oneOf(raw, "visibility", where, VISIBILITIES),
      lifecycleState,
      commentsState:
        raw.commentsState === undefined
          ? "OPEN"
          : oneOf(raw, "commentsState", where, COMMENTS_STATES),
      createdMs: authoredMs,
      // NULL while DRAFT: publishing one is a state transition, and a draft with
      // a publish time is a post an agent would believe is already live.
      publishedMs: lifecycleState === "DRAFT" ? null : authoredMs,
      comments,
      reactions,
    };
  });
}

/** The whole request, checked. Throws `BadRequestError` with a fixable message. */
export function parseSeedRequest(body: unknown): ParsedSeed {
  const root = object(body, "body");

  // Redundant with the URL on purpose: a mis-routed seed has to be loud, because
  // the alternative is an empty company page that answers 200.
  if (root.twin !== "linkedin") {
    throw new BadRequestError(
      `this twin seeds 'linkedin', not ${JSON.stringify(root.twin)} — post the linkedin ` +
        `wire seed here and the others to their own twins`,
    );
  }

  const seed = object(root.seed, "seed");
  const world = object(seed.world, "seed.world");
  const cast = castOf(world);
  // email (lowercased) -> the cast's spelling of that person's name.
  const known = new Map(cast.map((p) => [p.email.toLowerCase(), p.name]));

  const ownerEmail = text(seed, "ownerEmail", "seed");
  const ownerName = known.get(ownerEmail.toLowerCase());
  if (ownerName === undefined) {
    throw new BadRequestError(
      `seed.ownerEmail "${ownerEmail}" is not in seed.world.cast — the LinkedIn owner must ` +
        `be a member of the cast the other twins seeded from`,
    );
  }

  const members = parseMembers(array(seed, "members", "seed"), known);
  const owner = members.find((m) => m.email.toLowerCase() === ownerEmail.toLowerCase());
  if (!owner) {
    throw new BadRequestError(
      `seed.ownerEmail "${ownerEmail}" has no seed.members entry — the owner is who every ` +
        `write is attributed to, so they need a LinkedIn person id`,
    );
  }

  const orgRaw = object(seed.organization, "seed.organization");
  const organization: ParsedOrganization = {
    id: decimalId(orgRaw, "id", "seed.organization"),
    name: text(orgRaw, "name", "seed.organization"),
    vanityName: optionalText(orgRaw, "vanityName", "seed.organization"),
  };

  const directory: Directory = {
    urnByEmail: new Map(members.map((m) => [m.email.toLowerCase(), personUrn(m.personId)])),
    organizationUrn: organizationUrn(organization.id),
    ownerUrn: personUrn(owner.personId),
  };

  const promote = seed.promoteToSnapshot;
  if (promote !== undefined && typeof promote !== "boolean") {
    throw new BadRequestError("seed.promoteToSnapshot must be a boolean when present");
  }

  const business = object(world.business, "seed.world.business");

  return {
    nowMs: instant(seed, "nowISO", "seed"),
    ownerEmail,
    ownerName,
    ownerPersonId: owner.personId,
    businessName: text(business, "name", "seed.world.business"),
    promoteToSnapshot: promote === true,
    organization,
    members,
    posts: parsePosts(array(seed, "posts", "seed"), directory),
  };
}
