import { startNewSession } from "../audit";
import { applySchema, getDb } from "../db";
import { snapshotWorking } from "../reset";
import { activityUrn, commentUrn } from "../linkedin/urn";
import { insertComment } from "../store/comments";
import { countAll } from "../store/counts";
import { insertMember } from "../store/members";
import { setMeta } from "../store/meta";
import { insertAcl, insertOrganization } from "../store/organizations";
import { insertPost } from "../store/posts";
import { upsertReaction } from "../store/reactions";
import type { ParsedSeed, SeedResult } from "./types";

// Loading a cloned business into the company page.
//
// Total, never additive: the previous company is deleted first, because a page
// carrying two companies' posts is a world no episode described. Everything is
// written verbatim — the seed's own ids, absolute timestamps, author and actor
// URNs — so the post the director later comments on is the post the seed
// created, and the Priya in the comments is the Priya in the inbox.
//
// With `promoteToSnapshot` the seeded state becomes what every later `reset` in
// the run returns to, which is what lets a cloned business survive an episode.
// Without it the pristine snapshot is left exactly as it was.

export function seedFromWire(seed: ParsedSeed): SeedResult {
  const db = getDb();
  // Idempotent, and it makes a working.db that was never `db:init`ed seedable.
  applySchema(db);

  const write = db.transaction(() => {
    // Children first: the cascades would handle most of this, but reactions
    // have no foreign key at all and would otherwise outlive their entities.
    db.prepare("DELETE FROM reactions").run();
    db.prepare("DELETE FROM comments").run();
    db.prepare("DELETE FROM posts").run();
    db.prepare("DELETE FROM organization_acls").run();
    db.prepare("DELETE FROM organizations").run();
    db.prepare("DELETE FROM members").run();
    db.prepare("DELETE FROM meta").run();

    // The two keys the API reads back, and only those. A meta row nothing reads
    // is a claim about the world that no route can be wrong about, so nothing
    // ever catches it going stale.
    setMeta(db, "owner_person_id", seed.ownerPersonId);
    setMeta(db, "organization_id", seed.organization.id);

    for (const member of seed.members) {
      insertMember(db, {
        id: member.personId,
        email: member.email,
        givenName: member.givenName,
        familyName: member.familyName,
        isOwner: member.personId === seed.ownerPersonId,
      });
    }

    insertOrganization(db, {
      id: seed.organization.id,
      name: seed.organization.name,
      vanityName: seed.organization.vanityName || null,
    });

    for (const member of seed.members) {
      // The owner always administers the page: a page nobody administers cannot
      // be posted to, which would make the clone's headline task impossible.
      if (member.pageAdmin || member.personId === seed.ownerPersonId) {
        insertAcl(db, { organizationId: seed.organization.id, memberId: member.personId });
      }
    }

    for (const post of seed.posts) {
      insertPost(db, {
        id: post.id,
        authorUrn: post.authorUrn,
        commentary: post.commentary,
        visibility: post.visibility,
        lifecycleState: post.lifecycleState,
        commentsState: post.commentsState,
        // Authored at the world's own instants, never wall-clock: re-seeding the
        // same world twice has to produce the same page.
        createdMs: post.createdMs,
        publishedMs: post.publishedMs,
        lastModifiedMs: post.publishedMs ?? post.createdMs,
        // Seeded history belongs to the world; only the agent's own writes carry
        // the sandbox-created flag the judge reads.
        isSandboxCreated: false,
      });

      // Parents before replies — the parse pass already flattened them in that
      // order, so the foreign key on parent_comment_id is always satisfiable.
      for (const comment of post.comments) {
        insertComment(db, {
          id: comment.id,
          postId: post.id,
          parentCommentId: comment.parentCommentId,
          actorUrn: comment.actorUrn,
          agentUrn: comment.agentUrn,
          text: comment.text,
          createdMs: comment.createdMs,
          isSandboxCreated: false,
        });
        for (const reaction of comment.reactions) {
          upsertReaction(db, {
            actorUrn: reaction.actorUrn,
            entityUrn: commentUrn(post.id, comment.id),
            reactionType: reaction.reactionType,
            createdMs: reaction.createdMs,
            isSandboxCreated: false,
          });
        }
      }

      for (const reaction of post.reactions) {
        upsertReaction(db, {
          actorUrn: reaction.actorUrn,
          // Canonical activity form, so a later like by share URN collides with
          // this row rather than doubling the count.
          entityUrn: activityUrn(post.id),
          reactionType: reaction.reactionType,
          createdMs: reaction.createdMs,
          isSandboxCreated: false,
        });
      }
    }
  });

  write();
  const counts = countAll(db);

  // Closes and reopens the working handle, so nothing may hold `db` past here.
  if (seed.promoteToSnapshot) snapshotWorking();

  // A new world deserves a new audit session: the trail the judge reads must not
  // begin in the middle of the company that was here before.
  startNewSession(getDb(), `seeded ${seed.businessName}`, seed.nowMs);

  return { ok: true, counts };
}
