import {
  activityUrn,
  commentUrn,
  likeUrn,
  organizationUrn,
  personUrn,
  reactionUrn,
  shareUrn,
} from "./urn";

// ---------------------------------------------------------------------------
// The fidelity linchpin, LinkedIn edition. Columns are the source of truth for
// anything the API can filter or mutate on; raw_json carries only the fields the
// sandbox stores and never reasons about (content, contentCallToActionLabel,
// contentLandingPage). Every read rebuilds the resource from the columns and
// layers the passthrough underneath, so a caller cannot tell a seeded post from
// one the agent wrote.
// ---------------------------------------------------------------------------

// --- rows, exactly as SQLite returns them ------------------------------------

export interface MemberRow {
  id: string;
  email: string;
  given_name: string;
  family_name: string;
  picture_url: string | null;
  locale: string;
  is_owner: number;
}

export interface OrganizationRow {
  id: string;
  name: string;
  vanity_name: string | null;
}

export interface OrganizationAclRow {
  organization_id: string;
  member_id: string;
  role: string;
  state: string;
}

export interface PostRow {
  id: string;
  author_urn: string;
  commentary: string;
  visibility: string;
  feed_distribution: string;
  lifecycle_state: string;
  is_edited: number;
  is_reshare_disabled: number;
  comments_state: string;
  created_ms: number;
  published_ms: number | null;
  last_modified_ms: number;
  deleted_ms: number | null;
  raw_json: string | null;
  is_sandbox_created: number;
}

export interface CommentRow {
  id: string;
  post_id: string;
  parent_comment_id: string | null;
  actor_urn: string;
  agent_urn: string | null;
  message_text: string;
  attributes_json: string | null;
  created_ms: number;
  last_modified_ms: number;
  is_sandbox_created: number;
}

export interface ReactionRow {
  actor_urn: string;
  entity_urn: string;
  reaction_type: string;
  created_ms: number;
  last_modified_ms: number;
  is_sandbox_created: number;
}

// --- resources ---------------------------------------------------------------

/** LinkedIn's audit stamp. `impersonator` appears when a page acted, not a person. */
export interface AuditStamp {
  actor: string;
  impersonator?: string;
  time: number;
}

export interface LocalizedString {
  localized: Record<string, string>;
  preferredLocale: { country: string; language: string };
}

export interface PostResource {
  id: string;
  author: string;
  commentary: string;
  visibility: string;
  distribution: { feedDistribution: string; thirdPartyDistributionChannels: unknown[] };
  lifecycleState: string;
  lifecycleStateInfo: { isEditedByAuthor: boolean };
  isReshareDisabledByAuthor: boolean;
  content: Record<string, unknown>;
  contentCallToActionLabel?: string;
  contentLandingPage?: string;
  createdAt: number;
  lastModifiedAt: number;
  publishedAt?: number;
}

export interface LikesSummary {
  aggregatedTotalLikes: number;
  totalLikes: number;
  likedByCurrentUser: boolean;
  selectedLikes: string[];
}

export interface CommentResource {
  actor: string;
  agent?: string;
  commentUrn: string;
  id: string;
  object: string;
  parentComment?: string;
  created: AuditStamp;
  lastModified: AuditStamp;
  message: { attributes: unknown[]; text: string };
  likesSummary?: LikesSummary;
}

export interface SocialMetadataResource {
  entity: string;
  commentsState: string;
  commentSummary: { count: number; topLevelCount: number };
  reactionSummaries: Record<string, { reactionType: string; count: number }>;
}

export interface ReactionResource {
  id: string;
  reactionType: string;
  root: string;
  created: AuditStamp;
  lastModified: AuditStamp;
}

export interface UserInfoResource {
  sub: string;
  name: string;
  given_name: string;
  family_name: string;
  picture?: string;
  locale: string;
  email: string;
  email_verified: boolean;
}

export interface OrganizationResource {
  id: number;
  $URN: string;
  name: LocalizedString;
  localizedName: string;
  vanityName?: string;
}

export interface OrganizationAclElement {
  role: string;
  state: string;
  roleAssignee: string;
  organization: string;
  organizationTarget: string;
}

// --- helpers -----------------------------------------------------------------

/** The `{localized, preferredLocale}` wrapper LinkedIn puts around display text. */
export function localized(value: string): LocalizedString {
  return {
    localized: { en_US: value },
    preferredLocale: { country: "US", language: "en" },
  };
}

/** Never throws: a raw_json blob that got mangled must not 500 a read. */
function safeParse(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Same discipline for the comment `attributes` array: bad JSON reads as none. */
function safeParseArray(text: string | null): unknown[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The only post fields the clone stores whole and never interprets. */
export const PASSTHROUGH_KEYS = [
  "content",
  "contentCallToActionLabel",
  "contentLandingPage",
] as const;

export function passthroughOf(raw: string | null): Record<string, unknown> {
  const parsed = safeParse(raw);
  if (!parsed) return {};
  const out: Record<string, unknown> = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (parsed[key] !== undefined) out[key] = parsed[key];
  }
  return out;
}

function isOrganizationUrn(urn: string): boolean {
  return urn.startsWith("urn:li:organization:");
}

// --- shapers -----------------------------------------------------------------

export function shapePost(row: PostRow): PostResource {
  const extra = passthroughOf(row.raw_json);
  const resource: PostResource = {
    id: shareUrn(row.id),
    author: row.author_urn,
    commentary: row.commentary,
    visibility: row.visibility,
    // `targetEntities` is a create-request field: every documented read sample
    // returns feedDistribution and thirdPartyDistributionChannels only.
    distribution: {
      feedDistribution: row.feed_distribution,
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: row.lifecycle_state,
    lifecycleStateInfo: { isEditedByAuthor: row.is_edited === 1 },
    isReshareDisabledByAuthor: row.is_reshare_disabled === 1,
    // A text-only post really does come back with an empty `content` object at
    // LinkedIn, so the empty case is emitted rather than omitted.
    content: (extra.content as Record<string, unknown>) ?? {},
    // Epoch-ms NUMBERS, not ISO strings. Everything else in this repo emits
    // ISO; the Posts API does not, and an agent parsing these as dates has to
    // find a number here or it silently gets 1970.
    createdAt: row.created_ms,
    lastModifiedAt: row.last_modified_ms,
  };
  if (typeof extra.contentCallToActionLabel === "string") {
    resource.contentCallToActionLabel = extra.contentCallToActionLabel;
  }
  if (typeof extra.contentLandingPage === "string") {
    resource.contentLandingPage = extra.contentLandingPage;
  }
  // A DRAFT has never been published, so the field is absent rather than null —
  // that absence is the only thing distinguishing it from a published post whose
  // publish time an agent might otherwise trust.
  if (row.published_ms !== null) resource.publishedAt = row.published_ms;
  return resource;
}

/** How many likers a comment previews. The clone's own bound — LinkedIn
 *  documents a preview cap on selectedComments, not on selectedLikes — so a
 *  heavily-liked comment cannot balloon a page of results. */
const SELECTED_LIKES_CAP = 3;

export function shapeComment(
  row: CommentRow,
  opts: { likes?: ReactionRow[]; ownerUrn: string },
): CommentResource {
  // When a page comments, LinkedIn records WHICH admin acted: `agent` on the
  // comment and `impersonator` inside both audit stamps. The clone's headline
  // task is replying as the Acme page, so this is the exact artifact an agent
  // produces and it has to carry the same fields.
  const agent = isOrganizationUrn(row.actor_urn) ? (row.agent_urn ?? undefined) : undefined;
  const stamp = (time: number): AuditStamp =>
    agent ? { actor: row.actor_urn, impersonator: agent, time } : { actor: row.actor_urn, time };

  const resource: CommentResource = {
    actor: row.actor_urn,
    commentUrn: commentUrn(row.post_id, row.id),
    id: row.id,
    object: activityUrn(row.post_id),
    created: stamp(row.created_ms),
    lastModified: stamp(row.last_modified_ms),
    // Mention annotations round-trip verbatim; the clone never renders the
    // `little` text format they describe.
    message: { attributes: safeParseArray(row.attributes_json), text: row.message_text },
  };
  if (agent) resource.agent = agent;
  if (row.parent_comment_id) {
    resource.parentComment = commentUrn(row.post_id, row.parent_comment_id);
  }
  // Omitted entirely on a create response: LinkedIn returns likesSummary from
  // reads only, and a brand-new comment trivially has none.
  if (opts.likes) {
    const self = commentUrn(row.post_id, row.id);
    resource.likesSummary = {
      aggregatedTotalLikes: opts.likes.length,
      totalLikes: opts.likes.length,
      likedByCurrentUser: opts.likes.some((r) => r.actor_urn === opts.ownerUrn),
      selectedLikes: opts.likes
        .slice(0, SELECTED_LIKES_CAP)
        .map((r) => likeUrn(r.actor_urn, self)),
    };
  }
  return resource;
}

export function shapeSocialMetadata(input: {
  entityUrn: string;
  commentsState: string;
  count: number;
  topLevelCount: number;
  reactionCounts: Record<string, number>;
}): SocialMetadataResource {
  const reactionSummaries: Record<string, { reactionType: string; count: number }> = {};
  // Types with a zero count are omitted entirely, which is what every documented
  // sample does — an agent reading `Object.keys(reactionSummaries)` should see
  // the reactions that happened, not the vocabulary.
  for (const [type, count] of Object.entries(input.reactionCounts)) {
    if (count > 0) reactionSummaries[type] = { reactionType: type, count };
  }
  return {
    entity: input.entityUrn,
    commentsState: input.commentsState,
    commentSummary: { count: input.count, topLevelCount: input.topLevelCount },
    reactionSummaries,
  };
}

export function shapeReaction(row: ReactionRow): ReactionResource {
  return {
    id: reactionUrn(row.actor_urn, row.entity_urn),
    reactionType: row.reaction_type,
    root: row.entity_urn,
    created: { actor: row.actor_urn, time: row.created_ms },
    lastModified: { actor: row.actor_urn, time: row.last_modified_ms },
  };
}

export function shapeUserInfo(row: MemberRow): UserInfoResource {
  const resource: UserInfoResource = {
    // The BARE person id. The agent builds `urn:li:person:<sub>` itself, exactly
    // as it would against the real OIDC endpoint.
    sub: row.id,
    name: `${row.given_name} ${row.family_name}`,
    given_name: row.given_name,
    family_name: row.family_name,
    // LinkedIn's own sample returns `locale` as a plain string here, not the
    // object the OIDC spec describes.
    locale: row.locale,
    email: row.email,
    email_verified: true,
  };
  if (row.picture_url) resource.picture = row.picture_url;
  return resource;
}

export function shapeOrganization(row: OrganizationRow): OrganizationResource {
  const resource: OrganizationResource = {
    // A NUMBER here, unlike every other id in this clone — the Organization
    // Lookup response is the one place LinkedIn hands back the bare numeric id
    // rather than a URN or a string, and it also carries `$URN` alongside it.
    id: Number(row.id),
    $URN: organizationUrn(row.id),
    name: localized(row.name),
    localizedName: row.name,
  };
  if (row.vanity_name) resource.vanityName = row.vanity_name;
  return resource;
}

export function shapeAcl(row: OrganizationAclRow): OrganizationAclElement {
  const org = organizationUrn(row.organization_id);
  return {
    role: row.role,
    state: row.state,
    roleAssignee: personUrn(row.member_id),
    // Both spellings, with the same value: LinkedIn's own documentation returns
    // `organization` in one sample on the page and `organizationTarget` in the
    // next, so an agent written against either sample reads a URN here rather
    // than `undefined`. There is no third behaviour that is more correct.
    organization: org,
    organizationTarget: org,
  };
}
