import type { Database } from "better-sqlite3";
import { newCommentId, newPostId } from "../linkedin/ids";
import {
  activityUrn,
  canonicalEntityUrn,
  commentUrn,
  organizationUrn,
  parseCommentUrn,
  personUrn,
  postIdFromUrn,
  shareUrn,
} from "../linkedin/urn";
import { getCommentRow, insertComment } from "../store/comments";
import { getMemberByEmail, getOwnerMember } from "../store/members";
import { getOrganizationId } from "../store/meta";
import { getLivePostRow, insertPost } from "../store/posts";
import { upsertReaction } from "../store/reactions";
import { BadRequestError } from "./auth";

// The director's beats, factored out of the route so the route stays a thin
// transaction wrapper.
//
// Injection is scenario setup, not agent behaviour, so nothing here is
// audit-logged and every row carries `is_sandbox_created = 0`. The judge reads
// the audit log to score the agent, and a directed comment scored as the agent's
// work is the worst failure this file can have.

export interface TimeSpec {
  atMs?: number;
  atISO?: string;
}

/**
 * Never falls back to Date.now(). A comment stamped with wall-clock time inside
 * a simulated Tuesday morning makes the whole day incoherent to the agent
 * reading it, and the failure is silent — the row looks fine.
 */
export function resolveAt(spec: TimeSpec, what: string): number {
  if (typeof spec.atMs === "number" && Number.isFinite(spec.atMs)) return spec.atMs;
  if (typeof spec.atISO === "string") {
    const ms = Date.parse(spec.atISO);
    if (Number.isNaN(ms)) throw new BadRequestError(`${what}: atISO "${spec.atISO}" is not a date`);
    return ms;
  }
  throw new BadRequestError(`${what}: atMs or atISO is required`);
}

/**
 * Resolve an actor. Members are never minted on the fly: an author the cast has
 * never heard of shows up to the agent as a stranger, which is a scenario bug
 * worth surfacing rather than papering over.
 */
function actorUrnFor(
  db: Database,
  spec: { actorKind?: string; actorEmail?: string },
  what: string,
): { actorUrn: string; agentUrn: string | null } {
  if (spec.actorKind === "organization") {
    const orgId = getOrganizationId(db);
    if (!orgId) throw new BadRequestError(`${what}: this world has no company page to act as`);
    const owner = getOwnerMember(db);
    if (!owner) throw new BadRequestError(`${what}: no owner member — seed first`);
    return { actorUrn: organizationUrn(orgId), agentUrn: personUrn(owner.id) };
  }
  if (!spec.actorEmail) throw new BadRequestError(`${what}: actorEmail is required`);
  const member = getMemberByEmail(db, spec.actorEmail);
  if (!member) {
    throw new BadRequestError(
      `${what}: "${spec.actorEmail}" is not a member of this world — seed them first`,
    );
  }
  return { actorUrn: personUrn(member.id), agentUrn: null };
}

/**
 * The post a beat attaches to. Published only, and the DRAFT case gets its own
 * message: nobody can comment on or react to a post that was never published,
 * the wire seed refuses to describe that world (see parse.ts) and every
 * reader-facing route now 404s one — so a beat aimed at a draft would write a
 * row no agent could ever see, and the scenario would look like it landed.
 */
function requirePublishedTarget(db: Database, postId: string, what: string, named: string): void {
  const row = getLivePostRow(db, postId);
  if (!row) throw new BadRequestError(`${what}: no such post ${named}`);
  if (row.lifecycle_state === "DRAFT") {
    throw new BadRequestError(
      `${what}: ${named} is a DRAFT — nothing can engage with a post that was never published`,
    );
  }
}

export interface InjectPostSpec extends TimeSpec {
  slotId?: string;
  actorKind?: "organization" | "member";
  actorEmail?: string;
  commentary?: string;
  visibility?: string;
}

export interface InjectedPost {
  slotId: string;
  id: string;
  urn: string;
}

/** Someone else in the world publishes something the agent may need to react to. */
export function injectPost(db: Database, spec: InjectPostSpec): InjectedPost {
  const atMs = resolveAt(spec, "post");
  const { actorUrn } = actorUrnFor(db, spec, "post");
  const id = newPostId(atMs);
  insertPost(db, {
    id,
    authorUrn: actorUrn,
    commentary: spec.commentary ?? "",
    visibility: spec.visibility ?? "PUBLIC",
    createdMs: atMs,
    publishedMs: atMs,
    lastModifiedMs: atMs,
    isSandboxCreated: false,
  });
  return { slotId: spec.slotId ?? id, id, urn: shareUrn(id) };
}

export interface InjectCommentSpec extends TimeSpec {
  slotId?: string;
  postUrn?: string;
  parentCommentUrn?: string;
  actorKind?: "organization" | "member";
  actorEmail?: string;
  text?: string;
}

export interface InjectedComment {
  slotId: string;
  id: string;
  commentUrn: string;
  postUrn: string;
}

/**
 * The most-used beat: a customer comments on the company post and the agent has
 * to notice and answer.
 */
export function injectComment(db: Database, spec: InjectCommentSpec): InjectedComment {
  const atMs = resolveAt(spec, "comment");
  const { actorUrn, agentUrn } = actorUrnFor(db, spec, "comment");
  if (!spec.text) throw new BadRequestError("comment: text is required");

  let postId: string | null = null;
  let parentCommentId: string | null = null;
  if (spec.parentCommentUrn) {
    const parsed = parseCommentUrn(spec.parentCommentUrn);
    if (!parsed) {
      throw new BadRequestError(`comment: "${spec.parentCommentUrn}" is not a comment URN`);
    }
    const parent = getCommentRow(db, parsed.commentId);
    if (!parent) throw new BadRequestError(`comment: no such parent ${spec.parentCommentUrn}`);
    // Same one-level rule the wire seeder and the REST route enforce. A director
    // beat that replies to a reply would write a row nothing reads back.
    if (parent.parent_comment_id !== null) {
      throw new BadRequestError(
        `comment: ${spec.parentCommentUrn} is itself a reply — LinkedIn's comment threads are one level deep`,
      );
    }
    postId = parent.post_id;
    parentCommentId = parent.id;
  } else {
    postId = spec.postUrn ? postIdFromUrn(spec.postUrn) : null;
    if (!postId) throw new BadRequestError("comment: postUrn or parentCommentUrn is required");
  }
  requirePublishedTarget(db, postId, "comment", spec.postUrn ?? postId);

  const id = newCommentId(atMs);
  insertComment(db, {
    id,
    postId,
    parentCommentId,
    actorUrn,
    agentUrn,
    text: spec.text,
    createdMs: atMs,
    isSandboxCreated: false,
  });
  return {
    slotId: spec.slotId ?? id,
    id,
    commentUrn: commentUrn(postId, id),
    postUrn: shareUrn(postId),
  };
}

export interface InjectReactionSpec extends TimeSpec {
  entityUrn?: string;
  actorKind?: "organization" | "member";
  actorEmail?: string;
  reactionType?: string;
}

export interface InjectedReaction {
  actorUrn: string;
  entityUrn: string;
}

/** Engagement arriving over the course of a day. */
export function injectReaction(db: Database, spec: InjectReactionSpec): InjectedReaction {
  const atMs = resolveAt(spec, "reaction");
  const { actorUrn } = actorUrnFor(db, spec, "reaction");
  const root = spec.entityUrn ? canonicalEntityUrn(spec.entityUrn) : null;
  if (!root) {
    throw new BadRequestError(
      `reaction: entityUrn must be a post or comment URN, got ${JSON.stringify(spec.entityUrn)}`,
    );
  }
  const postId = postIdFromUrn(root);
  if (postId) requirePublishedTarget(db, postId, "reaction", String(spec.entityUrn));

  // A comment URN is only canonical once a row confirms BOTH halves. The thread
  // half has to name the post the comment is on, because the reaction is stored
  // against this exact string with no foreign key and every reader rebuilds it
  // from post_id + id — a near miss would be a directed beat that writes a row
  // the agent can never see, and the scenario would look like it had landed.
  const comment = parseCommentUrn(root);
  let entityUrn = root;
  if (comment) {
    const row = getCommentRow(db, comment.commentId);
    if (!row) throw new BadRequestError(`reaction: no such comment ${spec.entityUrn}`);
    if (row.post_id !== comment.postId) {
      throw new BadRequestError(
        `reaction: ${spec.entityUrn} names comment ${row.id}, which lives on ` +
          `${activityUrn(row.post_id)} — a comment URN carries the post it is on`,
      );
    }
    entityUrn = commentUrn(row.post_id, row.id);
  }

  upsertReaction(db, {
    actorUrn,
    entityUrn,
    reactionType: spec.reactionType ?? "LIKE",
    createdMs: atMs,
    isSandboxCreated: false,
  });
  return { actorUrn, entityUrn };
}
