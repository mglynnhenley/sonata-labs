import { describe, expect, it } from "vitest";
import { crmWriteTime, setMeta } from "@/lib/store/meta";
import { makeSeededDb, NOW, OWNER_ACTOR } from "./helpers";
import { writeValues } from "@/lib/attio/values";
import { OBJ_DEALS, SEED_DEAL_NORTHWIND } from "@/lib/seed";

describe("CRM version time", () => {
  it("uses wall time when the seeded history is in the past", () => {
    const db = makeSeededDb();
    expect(crmWriteTime(db, NOW + 1_000_000)).toBe(NOW + 1_000_000);
  });

  it("keeps writes after future-dated seeded and injected values without changing audit time", () => {
    const db = makeSeededDb();
    const future = NOW + 86_400_000;
    setMeta(db, "seeded_at", String(future));
    db.prepare("UPDATE attribute_values SET active_from_ms = ? WHERE active_until_ms IS NULL").run(future);
    const before = db.prepare("SELECT COUNT(*) AS n FROM audit.action_log").get();
    expect(crmWriteTime(db, NOW)).toBe(future + 1);
    expect(() => db.transaction(() => writeValues(db,
      { recordId: SEED_DEAL_NORTHWIND, objectId: OBJ_DEALS, objectSlug: "deals" },
      { stage: "Lost" }, { atMs: crmWriteTime(db, NOW), actor: OWNER_ACTOR, mode: "append" },
    ))()).not.toThrow();
    db.prepare("UPDATE attribute_values SET active_from_ms = ? WHERE active_until_ms IS NULL").run(future + 900_000);
    expect(crmWriteTime(db, NOW + 1)).toBe(future + 900_001);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit.action_log").get()).toEqual(before);
  });
  it("keeps a new memo after a future-dated imported transcript, and tasks after their creation", () => {
    const db = makeSeededDb();
    const transcriptTime = NOW + 7 * 86_400_000;
    db.prepare("UPDATE notes SET created_at_ms = ?").run(transcriptTime);
    expect(crmWriteTime(db, NOW)).toBe(transcriptTime + 1);
    db.prepare("UPDATE tasks SET created_at_ms = ?").run(transcriptTime + 1_000);
    expect(crmWriteTime(db, NOW)).toBe(transcriptTime + 1_001);
    db.prepare("UPDATE tasks SET is_completed = 1, completed_at_ms = ?").run(transcriptTime + 2_000);
    expect(crmWriteTime(db, NOW)).toBe(transcriptTime + 2_001);
  });
});
