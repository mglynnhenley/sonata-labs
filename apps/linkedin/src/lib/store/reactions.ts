import type { Database } from "better-sqlite3";
import type { ReactionRow } from "../linkedin/shape";

export interface ReactionInput {
  actorUrn: string;
  /** Canonicalised through urn.ts before it gets here: a post is its activity URN. */
  entityUrn: string;
  reactionType: string;
  createdMs: number;
  /** Absent means the WORLD wrote this row, matching db/schema.sql's DEFAULT 0. */
  isSandboxCreated?: boolean;
}

/**
 * One reaction per actor per entity, so a repeat POST is an upsert that changes
 * the type and bumps last_modified rather than adding a row.
 *
 * That upsert is the CLONE's choice, not a documented LinkedIn rule: the
 * Reactions API publishes Get, Batch Get, the two Creates and Delete, and says
 * nothing about what a second CREATE from the same actor does. The primary key
 * is certainly right — LinkedIn shows one reaction per member per entity — and
 * of the two possible answers to a repeat, forgiving it is the one that cannot
 * corrupt a count.
 *
 * `is_sandbox_created` follows the new reaction: once an agent has re-reacted
 * over a seeded row, the reaction says what the AGENT chose, and leaving the
 * flag at 0 would attribute the agent's decision to the world.
 */
export function upsertReaction(db: Database, input: ReactionInput): ReactionRow {
  db.prepare(
    `INSERT INTO reactions (actor_urn, entity_urn, reaction_type, created_ms, last_modified_ms, is_sandbox_created)
     VALUES (@actorUrn, @entityUrn, @reactionType, @createdMs, @createdMs, @isSandboxCreated)
     ON CONFLICT(actor_urn, entity_urn) DO UPDATE SET
       reaction_type = excluded.reaction_type,
       last_modified_ms = excluded.last_modified_ms,
       is_sandbox_created = excluded.is_sandbox_created`,
  ).run({
    actorUrn: input.actorUrn,
    entityUrn: input.entityUrn,
    reactionType: input.reactionType,
    createdMs: input.createdMs,
    isSandboxCreated: input.isSandboxCreated ? 1 : 0,
  });
  const row = getReaction(db, input.actorUrn, input.entityUrn);
  if (!row) throw new Error(`reaction on ${input.entityUrn} vanished after upsert`);
  return row;
}

export function getReaction(
  db: Database,
  actorUrn: string,
  entityUrn: string,
): ReactionRow | null {
  return (
    (db
      .prepare("SELECT * FROM reactions WHERE actor_urn = ? AND entity_urn = ?")
      .get(actorUrn, entityUrn) as ReactionRow) ?? null
  );
}

/**
 * Reactions for many entities in one query. The comments finder needs the likes
 * of every comment on the page it is returning, and doing that per row is the
 * kind of loop that quietly turns a ten-comment thread into eleven queries.
 */
export function reactionsForEntities(
  db: Database,
  entityUrns: string[],
): Map<string, ReactionRow[]> {
  const byEntity = new Map<string, ReactionRow[]>();
  if (!entityUrns.length) return byEntity;
  const placeholders = entityUrns.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT * FROM reactions WHERE entity_urn IN (${placeholders}) ORDER BY created_ms, actor_urn`,
    )
    .all(...entityUrns) as ReactionRow[];
  for (const row of rows) {
    const list = byEntity.get(row.entity_urn);
    if (list) list.push(row);
    else byEntity.set(row.entity_urn, [row]);
  }
  return byEntity;
}

/** Types with zero rows are simply absent, which is what shapeSocialMetadata needs. */
export function reactionCountsByType(db: Database, entityUrn: string): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT reaction_type, COUNT(*) AS n FROM reactions WHERE entity_urn = ? GROUP BY reaction_type",
    )
    .all(entityUrn) as Array<{ reaction_type: string; n: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.reaction_type] = row.n;
  return out;
}

export function countReactions(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM reactions").get() as { n: number }).n;
}
