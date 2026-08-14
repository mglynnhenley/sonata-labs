// The clone's spine. LinkedIn identifies everything by URN, and getting the URN
// algebra wrong is the single bug that would make this clone unrecognisable to
// an agent: the id it reads off a comment is the id it hands back to the posts
// endpoint, and if the two spellings do not line up nothing else matters.
//
// One deliberate simplification, stated here because it is the only place a
// reader would notice it: ONE numeric id backs a post's share, ugcPost and
// activity URNs. Real LinkedIn mints separate numbers and makes callers resolve
// between them; modelling that costs a resolution table and teaches an agent
// nothing, while accepting all three spellings everywhere gives it the
// behaviour that actually matters.

export type UrnKind = "person" | "organization" | "share" | "ugcPost" | "activity" | "comment";

export function personUrn(id: string): string {
  return `urn:li:person:${id}`;
}

export function organizationUrn(id: string): string {
  return `urn:li:organization:${id}`;
}

export function shareUrn(id: string): string {
  return `urn:li:share:${id}`;
}

export function activityUrn(id: string): string {
  return `urn:li:activity:${id}`;
}

/**
 * The composite comment URN. The thread half is always the ACTIVITY urn, never
 * the share urn — that is what LinkedIn returns, and an agent that pastes a
 * share-flavoured composite back into socialActions gets nothing at LinkedIn.
 */
export function commentUrn(postId: string, commentId: string): string {
  return `urn:li:comment:(${activityUrn(postId)},${commentId})`;
}

export function reactionUrn(actorUrn: string, entityUrn: string): string {
  return `urn:li:reaction:(${actorUrn},${entityUrn})`;
}

/** The legacy `likesSummary.selectedLikes` spelling, which Reactions never replaced. */
export function likeUrn(actorUrn: string, entityUrn: string): string {
  return `urn:li:like:(${actorUrn},${entityUrn})`;
}

// Two patterns, because the id alphabets genuinely differ: a person id is ten
// characters of base64url, while an organization, share, ugcPost or activity id
// is always decimal. Accepting `urn:li:share:abc` here would push the failure
// down to a lookup that answers 404, where the caller's real mistake was a
// malformed URN and LinkedIn would have said so.
const MEMBER_URN = /^urn:li:person:([A-Za-z0-9_-]+)$/;
const NUMERIC_URN = /^urn:li:(organization|share|ugcPost|activity):(\d+)$/;

/**
 * Never throws: a malformed string is null so callers can raise the documented
 * 400 rather than a 500. LinkedIn answers a bad URN with INVALID_URN_ID, and a
 * stack trace where the vendor sends a 400 is the failure this shape prevents.
 */
export function parseUrn(value: string): { kind: UrnKind; id: string } | null {
  const member = MEMBER_URN.exec(value);
  if (member) return { kind: "person", id: member[1] };
  const numeric = NUMERIC_URN.exec(value);
  if (numeric) return { kind: numeric[1] as UrnKind, id: numeric[2] };
  const comment = parseCommentUrn(value);
  return comment ? { kind: "comment", id: comment.commentId } : null;
}

const COMMENT_URN = /^urn:li:comment:\(urn:li:activity:(\d+),(\d+)\)$/;

export function parseCommentUrn(value: string): { postId: string; commentId: string } | null {
  const m = COMMENT_URN.exec(value);
  return m ? { postId: m[1], commentId: m[2] } : null;
}

/**
 * The one function that lets an agent take the `object` URN off a comment and
 * GET the post with it, exactly as it would against the real API: share,
 * ugcPost and activity all name the same row here.
 */
export function postIdFromUrn(value: string): string | null {
  const parsed = parseUrn(value);
  if (!parsed) return null;
  if (parsed.kind !== "share" && parsed.kind !== "ugcPost" && parsed.kind !== "activity") {
    return null;
  }
  return parsed.id;
}

/**
 * The form stored in `reactions.entity_urn`. Without one canonical spelling the
 * same person liking the same post by its share URN and then by its activity
 * URN would land as two rows and be counted twice.
 *
 * It canonicalises as far as a string can. A comment URN comes back unchanged
 * because the only thing that can tell one apart from a near miss is the row it
 * names — this file stays database-free — so the two callers that hold a `db`
 * finish the job by rebuilding the URN from the comment row and refusing a
 * thread half that names the wrong post.
 */
export function canonicalEntityUrn(value: string): string | null {
  const postId = postIdFromUrn(value);
  if (postId) return activityUrn(postId);
  return parseCommentUrn(value) ? value : null;
}

/**
 * Next has already percent-decoded the dynamic segment, so a normally-encoded
 * URN arrives ready to use. A double-encoded caller leaves `%3A` behind, and a
 * legitimate URN never contains a `%` — so decoding once more, only when one is
 * still present, is unambiguous.
 */
export function decodeUrnParam(raw: string): string {
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
