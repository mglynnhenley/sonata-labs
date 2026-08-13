import type { Database } from "better-sqlite3";
import {
  accessDeniedError,
  invalidUrnIdError,
  invalidUrnTypeError,
  LinkedInError,
  missingFieldError,
} from "./errors";
import { parseUrn, personUrn } from "./urn";
import { getMemberById } from "../store/members";
import { getOrganization, hasApprovedAdminAcl } from "../store/organizations";

// Who a write is attributed to, resolved once for all three write endpoints.
//
// The permission rule is the whole reason this is shared: an agent that learns
// it can post as any page it can name, or as any member whose id it has seen in
// a comment, has learned a permission model that does not exist. LinkedIn
// refuses both, and it refuses them with a 403 rather than a 404, because the
// caller can see the entity — it just may not act as it.

export interface ResolvedActor {
  urn: string;
  /** The admin acting on the page's behalf. Null when a person acts as themself. */
  agentUrn: string | null;
}

export function requireActor(
  db: Database,
  raw: unknown,
  opts: { field: string; ownerMemberId: string; action: string },
): ResolvedActor {
  if (typeof raw !== "string" || !raw) throw missingFieldError(opts.field);
  const parsed = parseUrn(raw);
  if (!parsed || (parsed.kind !== "person" && parsed.kind !== "organization")) {
    throw invalidUrnTypeError(opts.field, raw, "person or organization");
  }

  if (parsed.kind === "person") {
    if (!getMemberById(db, parsed.id)) throw invalidUrnIdError();
    if (parsed.id !== opts.ownerMemberId) {
      throw accessDeniedError(
        `Not enough permissions to access: ${opts.action}. ` +
          "A member may only act on their own behalf.",
      );
    }
    return { urn: raw, agentUrn: null };
  }

  if (!getOrganization(db, parsed.id)) throw invalidUrnIdError();
  if (!hasApprovedAdminAcl(db, parsed.id, opts.ownerMemberId)) {
    throw accessDeniedError(
      `Not enough permissions to access: ${opts.action}. ` +
        "An APPROVED ADMINISTRATOR role on the organization is required.",
    );
  }
  // A page never acts on its own: LinkedIn records the admin who did, and that
  // is what `agent` and `created.impersonator` carry on the resulting comment.
  return { urn: raw, agentUrn: personUrn(opts.ownerMemberId) };
}

/**
 * The same rule applied to a post that already exists, read off its own author.
 * Editing and deleting are `w_member_social` writes exactly as creating is, and
 * LinkedIn scopes all three to the authenticated member: a person's post is
 * theirs alone, a page's post belongs to whoever administers the page.
 *
 * Without this gate an agent that can merely NAME a post URN — one it read off a
 * comment, or guessed from a neighbouring id — can rewrite or destroy a
 * stranger's post and get a 204 for it. The audit log would then record a
 * postDelete on a post the twin should have refused, and no scenario could tell
 * "the agent overstepped" from "the API let it".
 */
export function requirePostAuthor(
  db: Database,
  authorUrn: string,
  opts: { ownerMemberId: string; action: string },
): void {
  requireActor(db, authorUrn, {
    field: "author",
    ownerMemberId: opts.ownerMemberId,
    action: opts.action,
  });
}

/**
 * The same rule again, asked without an opinion about the refusal — a delegation
 * rather than a second copy, because a permission model that exists twice is one
 * that will disagree with itself.
 *
 * The DRAFT reader is what needs it. `viewContext=AUTHOR` is not a password:
 * without this the owner could read — and the author finder could list — a draft
 * some OTHER member left unpublished, merely by naming them. And the answer
 * there has to be the 404 a reader already gets rather than the 403 the write
 * paths raise, because a 403 confirms the unpublished post exists, which is the
 * one thing a draft is entitled to hide.
 */
export function mayActAs(db: Database, actorUrn: string, ownerMemberId: string): boolean {
  try {
    requireActor(db, actorUrn, { field: "author", ownerMemberId, action: "GET /posts" });
    return true;
  } catch (err) {
    // Only the documented refusals mean "no". Anything else is a broken twin and
    // must not read as a permission answer.
    if (err instanceof LinkedInError) return false;
    throw err;
  }
}
