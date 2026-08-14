import type { Database } from "better-sqlite3";
import { requireActor } from "./actor";
import {
  fieldTooLongError,
  invalidValueError,
  missingFieldError,
  unpermittedFieldsError,
} from "./errors";
import { newPostId } from "./ids";
import { passthroughOf, type PostRow } from "./shape";
import type { PostInput, PostPatch } from "../store/posts";

// Validation and normalisation for a post body, shared by POST /rest/posts, the
// PARTIAL_UPDATE path and /api/sandbox/inject — so a directed post and an
// agent's post are the same artifact built the same way.

const VISIBILITIES = ["PUBLIC", "CONNECTIONS", "LOGGED_IN"] as const;

/** LinkedIn's real commentary limit. */
const COMMENTARY_MAX = 3000;

/** Exactly the set the Posts API documents as updatable. Anything else is a 403. */
const PATCHABLE = [
  "commentary",
  "contentCallToActionLabel",
  "contentLandingPage",
  "lifecycleState",
] as const;

/** The passthrough the clone stores and echoes but never interprets. */
const PASSTHROUGH_IN = ["content", "contentCallToActionLabel", "contentLandingPage"] as const;

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function passthroughFrom(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PASSTHROUGH_IN) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function requireCommentary(raw: unknown): string {
  // Deliberately NOT required and NOT blank-checked. LinkedIn's MISSING_FIELD
  // table names author, visibility, distribution and lifecycleState — not
  // commentary — and its own finder samples return live posts with
  // `"commentary": ""`, which is what a media-only post looks like.
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw invalidValueError("commentary", JSON.stringify(raw));
  if (raw.length > COMMENTARY_MAX) throw fieldTooLongError("commentary");
  return raw;
}

export function buildCreateInput(
  body: Record<string, unknown>,
  ctx: { db: Database; ownerMemberId: string; now: number },
): PostInput {
  const author = requireActor(ctx.db, body.author, {
    field: "author",
    ownerMemberId: ctx.ownerMemberId,
    action: "CREATE /posts",
  });

  const visibility = body.visibility;
  if (typeof visibility !== "string" || !visibility) throw missingFieldError("visibility");
  if (!(VISIBILITIES as readonly string[]).includes(visibility)) {
    throw invalidValueError("visibility", visibility);
  }

  const distribution = body.distribution;
  if (typeof distribution !== "object" || distribution === null) {
    throw missingFieldError("distribution");
  }
  const feedDistribution = objectOf(distribution).feedDistribution;
  if (typeof feedDistribution !== "string" || !feedDistribution) {
    throw missingFieldError("distribution.feedDistribution");
  }

  const lifecycleState = body.lifecycleState;
  if (typeof lifecycleState !== "string" || !lifecycleState) {
    throw missingFieldError("lifecycleState");
  }
  // PUBLISHED is the only value LinkedIn accepts on create; a draft is made by
  // creating it published and then patching, which reads backwards until you
  // hit the error, so the clone reproduces the error rather than the intuition.
  if (lifecycleState !== "PUBLISHED") throw invalidValueError("lifecycleState", lifecycleState);

  return {
    id: newPostId(ctx.now),
    authorUrn: author.urn,
    commentary: requireCommentary(body.commentary),
    visibility,
    feedDistribution,
    lifecycleState,
    isReshareDisabled: body.isReshareDisabledByAuthor === true,
    commentsState: "OPEN",
    createdMs: ctx.now,
    publishedMs: ctx.now,
    lastModifiedMs: ctx.now,
    extra: passthroughFrom(body),
    isSandboxCreated: true,
  };
}

export interface BuiltPatch {
  patch: PostPatch;
  /** True when this patch is the DRAFT -> PUBLISHED transition, which the audit
   *  trail records as its own verb: publishing the draft the CEO left is a
   *  different act from fixing a typo, and the judge has to be able to see it. */
  publishesDraft: boolean;
}

export function buildPatchInput(body: unknown, row: PostRow, now: number): BuiltPatch {
  const root = objectOf(body);
  // `adContext` rides as a SIBLING of `$set` in LinkedIn's documented patch
  // body. Sponsored content is out of scope here, and silently ignoring the key
  // would let an agent believe it had set an ad field, so it is refused.
  if (root.adContext !== undefined) throw unpermittedFieldsError(["/patch/adContext"]);

  const set = objectOf(root.$set);
  const unpermitted = Object.keys(set).filter(
    (key) => !(PATCHABLE as readonly string[]).includes(key),
  );
  if (unpermitted.length) {
    throw unpermittedFieldsError(unpermitted.map((key) => `/patch/$set/${key}`));
  }

  // Asked BEFORE anything is stamped, because every key that survives the filter
  // above sets something: "the patch changes nothing" and "$set names nothing"
  // are the same question. Stamping first made `{"patch":{"$set":{}}}` a 204 that
  // flipped isEditedByAuthor, wrote `Edited the post "…"` into the log the judge
  // grades from, and reordered the company feed — lastModifiedAt is the author
  // finder's default sort key — for a request that asked for no change at all.
  if (!Object.keys(set).length) throw missingFieldError("patch.$set");

  const patch: PostPatch = { lastModifiedMs: now, isEdited: true };
  if (set.commentary !== undefined) patch.commentary = requireCommentary(set.commentary);

  let publishesDraft = false;
  if (set.lifecycleState !== undefined) {
    const next = set.lifecycleState;
    if (next !== "PUBLISHED" && next !== "DRAFT") {
      throw invalidValueError("lifecycleState", String(next));
    }
    // DRAFT is the state content is in BEFORE it is published, and every patch
    // LinkedIn documents runs the other way. Backwards it is a takedown wearing
    // an edit's clothes: the post 404s on every reader surface and leaves the
    // author finder, yet publishesDraft is false, so the trail reads `Edited the
    // post "…"` and postDelete — the verb that exists to make destruction
    // visible to the judge — is never written. It would also leave published_ms
    // set, and a DRAFT carrying a publishedAt is the one post shape.ts and
    // sandbox/parse.ts agree cannot exist.
    if (next === "DRAFT" && row.lifecycle_state !== "DRAFT") {
      throw invalidValueError("lifecycleState", next);
    }
    patch.lifecycleState = next;
    // published_ms is stamped exactly once, on the transition — a second patch
    // of an already-published post must not move the publish time.
    if (next === "PUBLISHED" && row.published_ms === null) {
      patch.publishedMs = now;
      publishesDraft = true;
    }
  }

  const extra: Record<string, unknown> = {};
  for (const key of PASSTHROUGH_IN) {
    if (set[key] !== undefined) extra[key] = set[key];
  }
  if (Object.keys(extra).length) {
    // Merge, not replace: a patch that sets only the CTA label must not drop
    // the `content` the post was created with.
    patch.extra = { ...passthroughOf(row.raw_json), ...extra };
  }

  return { patch, publishesDraft };
}
