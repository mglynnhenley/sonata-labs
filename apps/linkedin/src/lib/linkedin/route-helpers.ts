import { NextResponse } from "next/server";
import type { Database } from "better-sqlite3";
import { checkAuth, checkProtocolHeader, checkVersionHeader } from "./auth";
import { badRequestError, notFoundError, toErrorResponse } from "./errors";
import { getDb } from "../db";
import { getCommentRow } from "../store/comments";
import { getOwnerPersonId } from "../store/meta";
import { getMemberById } from "../store/members";
import { getOrganization } from "../store/organizations";
import { getLivePostRow } from "../store/posts";
import { logAction, type ActionEntry } from "../audit";
import { parseCommentUrn, parseUrn, personUrn, postIdFromUrn } from "./urn";
import type { CommentRow, PostRow } from "./shape";

// Shared plumbing for every /v2/* and /rest/* handler: the bearer gate, the two
// Rest.li header gates, and error translation. Nothing in a route touches
// getDb(), checkAuth() or the error envelope directly.

export interface LinkedInCtx {
  db: Database;
  ownerMemberId: string;
  ownerPersonUrn: string;
}

export async function handleLinkedIn(
  req: Request,
  fn: (ctx: LinkedInCtx) => Promise<NextResponse> | NextResponse,
): Promise<NextResponse> {
  const authErr = checkAuth(req);
  if (authErr) return authErr;
  // Versioning is decided from the pathname rather than from an options
  // argument, so there is no way for a route to get it wrong: /rest/ is the
  // versioned surface, /v2/ is not.
  if (new URL(req.url).pathname.startsWith("/rest/")) {
    const versionErr = checkVersionHeader(req);
    if (versionErr) return versionErr;
  }
  const protocolErr = checkProtocolHeader(req);
  if (protocolErr) return protocolErr;
  try {
    const db = getDb();
    const ownerMemberId = getOwnerPersonId(db);
    return await fn({ db, ownerMemberId, ownerPersonUrn: personUrn(ownerMemberId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

/** PARTIAL_UPDATE and DELETE on a post both answer 204 with an empty body. */
export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

/**
 * A Rest.li create. The id goes in the `x-restli-id` header — every LinkedIn
 * client reads `createdEntityId` off that header, so a 201 without it is
 * invisible to the caller no matter what the body says.
 *
 * The body is deliberately caller-supplied: post creates return NO body at all
 * and a URN-valued header, comment creates return the full entity and a bare
 * numeric header. Both are what LinkedIn does, and the asymmetry is load-bearing.
 */
export function created(entityId: string, body?: unknown): NextResponse {
  const headers = { "x-restli-id": entityId };
  return body === undefined
    ? new NextResponse(null, { status: 201, headers })
    : NextResponse.json(body, { status: 201, headers });
}

/**
 * `X-RestLi-Method`, uppercased. This matters more than it looks: the docs show
 * `PARTIAL_UPDATE` but LinkedIn's own JavaScript client sends `partial_update`
 * lowercase, so a case-sensitive comparison would pass every hand-written curl
 * and fail every SDK caller.
 */
export function restliMethod(req: Request): string | null {
  const raw = req.headers.get("x-restli-method");
  return raw ? raw.toUpperCase() : null;
}

/** Resolve a post URN in any of its three spellings, or throw LinkedIn's 404. */
export function requirePost(db: Database, urn: string): PostRow {
  const id = postIdFromUrn(urn);
  const row = id ? getLivePostRow(db, id) : null;
  if (!row) throw notFoundError("The requested post was not found.");
  return row;
}

/**
 * The same lookup for every surface that is not the post resource itself. A
 * DRAFT has no reader but its author, so socialMetadata, the comments finder and
 * reactions all answer 404 for one — otherwise the unpublished post the owner
 * left leaks its existence and its activity URN to anyone who asks the wrong
 * endpoint, and worse, becomes engageable. A published-only resolver is the only
 * thing keeping those routes from contradicting sandbox/parse.ts, which refuses
 * to even describe a DRAFT that carries engagement.
 */
export function requirePublishedPost(db: Database, urn: string): PostRow {
  const row = requirePost(db, urn);
  if (row.lifecycle_state === "DRAFT") throw notFoundError("The requested post was not found.");
  return row;
}

/**
 * Resolve a composite comment URN, insisting that BOTH halves agree: the thread
 * half has to name the post the comment actually lives on. A near miss is a 404,
 * not a resolution by comment id alone, because a reaction is stored against
 * this exact string with no foreign key — so a row written under a wrong-thread
 * spelling is invisible for ever to socialMetadata and to likesSummary, which
 * rebuild the URN from post_id + id. The caller got a 201 and the world did not
 * change, which is the one failure a reaction must never have.
 */
export function requireComment(db: Database, urn: string): CommentRow {
  const parsed = parseCommentUrn(urn);
  const row = parsed ? getCommentRow(db, parsed.commentId) : null;
  if (!parsed || !row || row.post_id !== parsed.postId) {
    throw notFoundError("The requested entity was not found.");
  }
  return row;
}

/**
 * The comment a reply is allowed to hang under. Threads are one level deep, and
 * this refusal lives in ONE place because it used to live in two and only one of
 * them ran: the comments route checked the parent named as the path segment and
 * not the one named by `parentComment` in the body, so the body spelling wrote a
 * depth-2 row that no reader can return — `listReplies` yields direct children
 * only, and the finder for the row's own parent is itself this 400. The agent got
 * a 201 and an audit line saying it answered a customer nobody can see it answer.
 */
export function requireThreadParent(db: Database, urn: string): CommentRow {
  const row = requireComment(db, urn);
  if (row.parent_comment_id !== null) {
    throw badRequestError(
      "A reply cannot be answered directly — LinkedIn's comment threads are one level deep. " +
        "Address the comment the reply is under.",
    );
  }
  return row;
}

/** Audit summaries are read by a person, so they quote the text they are about. */
export function snippet(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * A name for an actor URN, for the summary line. Falls back to the URN itself
 * rather than to "unknown": a summary naming a URN is still resolvable, and a
 * summary saying "unknown" tells the judge nothing at all.
 */
export function actorLabel(db: Database, urn: string): string {
  const parsed = parseUrn(urn);
  if (parsed?.kind === "organization") {
    return getOrganization(db, parsed.id)?.name ?? urn;
  }
  if (parsed?.kind === "person") {
    const member = getMemberById(db, parsed.id);
    return member ? `${member.given_name} ${member.family_name}` : urn;
  }
  return urn;
}

/**
 * Run a mutation atomically: fn performs the change, then the audit row is
 * written in the SAME transaction (audit.db is ATTACHed). A rolled-back
 * mutation therefore leaves no evidence of an action that never happened.
 */
export function runMutation<T>(
  db: Database,
  fn: () => T,
  buildEntry: (result: T) => ActionEntry,
): T {
  const tx = db.transaction(() => {
    const result = fn();
    logAction(db, buildEntry(result));
    return result;
  });
  return tx();
}
