import { startNewSession } from "../audit";
import { applySchema, getDb } from "../db";
import { seededRevisionId } from "../docs/ids";
import { snapshotWorking } from "../reset";
import {
  countDocuments,
  countParagraphs,
  deleteAllDocuments,
  insertDocument,
} from "../store/documents";
import { setMeta } from "../store/meta";
import { markWorkingSwapped } from "./live";
import { toParagraphModels } from "./parse";
import type { ParsedSeed, SeedResult } from "./types";

// Loading a cloned business into the document set.
//
// Total, never additive: the previous company's documents are deleted, because a
// workspace carrying two companies' briefs is a world no episode described.
// Everything is written verbatim from the seed's own ids and timestamps, so the
// document the director later edits by id is the document the seed created — and
// the "Q3 Business Review" a Gmail thread links to is this one.
//
// Snapshot handling mirrors the other twins: with `promoteToSnapshot` the seeded
// state becomes what every later `reset` in the run returns to, which is what
// lets a cloned business survive an episode. Without it the pristine snapshot is
// left exactly as it was.

export function seedFromWire(seed: ParsedSeed): SeedResult {
  const db = getDb();
  // Idempotent, and it makes a working.db that was never `db:init`ed seedable.
  applySchema(db);

  const write = db.transaction(() => {
    deleteAllDocuments(db);
    db.prepare("DELETE FROM meta").run();

    setMeta(db, "owner_email", seed.ownerEmail);
    setMeta(db, "owner_name", seed.ownerName);
    setMeta(db, "seeded_at", String(seed.nowMs));

    for (const doc of seed.documents) {
      insertDocument(db, {
        id: doc.id,
        title: doc.title,
        ownerEmail: doc.ownerEmail,
        // Authored at the world's instant, not at wall-clock time, and with a
        // revision id derived from it: re-seeding the same world twice has to
        // produce the same documents, down to the revision a snapshot diff reads.
        revisionId: seededRevisionId(doc.id, seed.nowMs),
        paragraphs: toParagraphModels(doc.paragraphs),
        createdMs: seed.nowMs,
        updatedMs: seed.nowMs,
        // Seeded history belongs to the world; only the agent's own writes carry
        // the sandbox-created flag the judge reads.
        isSandboxCreated: false,
      });
    }
  });

  write();
  const counts = { documents: countDocuments(db), paragraphs: countParagraphs(db) };

  // Closes and reopens the working handle, so nothing may hold `db` past here.
  if (seed.promoteToSnapshot) snapshotWorking();

  // A new world deserves a new audit session: the trail the judge reads must not
  // begin in the middle of the company that was here before.
  startNewSession(getDb(), `seeded ${seed.businessName}`, seed.nowMs);
  markWorkingSwapped();

  return { ok: true, counts };
}
