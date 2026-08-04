import { describe, it, expect } from "vitest";
import { makeSeededDb } from "./helpers";
import { getHistory, getReplies, getMessage } from "@/lib/store/messages";
import { getReactionsFor } from "@/lib/store/reactions";
import { listPins } from "@/lib/store/pins";
import { getFilesForMessage } from "@/lib/store/files";
import { listConversations, isMember, getConversation } from "@/lib/store/conversations";
import { getSelf } from "@/lib/store/meta";
import { getUser, countUsers } from "@/lib/store/users";
import { CH_GENERAL, CH_ENG, CH_LEADERSHIP, DM_PRIYA, MPIM, ME } from "@/lib/seed";
import type Database from "better-sqlite3";

describe("seeded workspace", () => {
  const db = makeSeededDb();

  it("records self identity in meta", () => {
    const self = getSelf(db);
    expect(self.userId).toBe(ME);
    expect(self.teamName).toBe("Acme");
  });

  it("seeds users including one bot", () => {
    expect(countUsers(db)).toBe(8);
    const bot = getUser(db, "U0DEPLOYB01")!;
    expect(bot.is_bot).toBe(1);
    expect(getUser(db, ME)!.name).toBe("matilda");
  });

  it("seeds all conversation types", () => {
    const pub = listConversations(db, { types: ["public_channel"], excludeArchived: true, afterId: null, limit: 100 });
    const priv = listConversations(db, { types: ["private_channel"], excludeArchived: true, afterId: null, limit: 100 });
    const ims = listConversations(db, { types: ["im"], excludeArchived: true, afterId: null, limit: 100 });
    const mpims = listConversations(db, { types: ["mpim"], excludeArchived: true, afterId: null, limit: 100 });
    expect(pub.map((c) => c.name).sort()).toEqual(["engineering", "general", "random"]);
    expect(priv.map((c) => c.name)).toEqual(["leadership"]);
    expect(ims).toHaveLength(2);
    expect(mpims).toHaveLength(1);
    // private_channel must not leak the mpim
    expect(priv.some((c) => c.id === MPIM)).toBe(false);
  });

  it("maintains membership and num_members", () => {
    expect(isMember(db, CH_LEADERSHIP, ME)).toBe(true);
    expect(isMember(db, CH_LEADERSHIP, "U0JORDAN001")).toBe(false);
    expect(getConversation(db, CH_GENERAL)!.num_members).toBe(8);
    expect(getConversation(db, DM_PRIYA)!.num_members).toBe(2);
  });

  it("history returns roots only, newest first", () => {
    const hist = getHistory(db, CH_ENG, { limit: 100 });
    expect(hist.length).toBeGreaterThan(5);
    // No thread replies inline
    expect(hist.every((m) => !m.thread_ts || m.thread_ts === m.ts)).toBe(true);
    // Newest first
    const tss = hist.map((m) => m.ts);
    expect([...tss].sort().reverse()).toEqual(tss);
  });

  it("thread bookkeeping on roots is correct", () => {
    const hist = getHistory(db, CH_ENG, { limit: 100 });
    const incident = hist.find((m) => m.text?.includes("Elevated 5xx"))!;
    expect(incident.reply_count).toBe(4);
    expect(incident.thread_ts).toBe(incident.ts);
    expect(incident.latest_reply).toBeTruthy();
    expect(incident.reply_users_count).toBeGreaterThanOrEqual(2);

    const replies = getReplies(db, CH_ENG, incident.ts, { limit: 100 });
    expect(replies).toHaveLength(5); // parent + 4
    expect(replies[0].ts).toBe(incident.ts);
    expect(replies.slice(1).every((r) => r.thread_ts === incident.ts)).toBe(true);
  });

  it("history slicing with oldest/latest works", () => {
    const all = getHistory(db, CH_GENERAL, { limit: 100 });
    const pivot = all[3].ts;
    const newer = getHistory(db, CH_GENERAL, { oldest: pivot, limit: 100 });
    expect(newer.map((m) => m.ts)).toEqual(all.slice(0, 3).map((m) => m.ts));
    const newerInc = getHistory(db, CH_GENERAL, { oldest: pivot, inclusive: true, limit: 100 });
    expect(newerInc).toHaveLength(4);
  });

  it("reactions group correctly", () => {
    const hist = getHistory(db, CH_GENERAL, { limit: 100 });
    const welcome = hist.find((m) => m.text?.startsWith("Welcome"))!;
    const reactions = getReactionsFor(db, CH_GENERAL, welcome.ts);
    expect(reactions).toHaveLength(1);
    expect(reactions[0].name).toBe("wave");
    expect(reactions[0].count).toBe(4);
    expect(reactions[0].users).toHaveLength(4);
  });

  it("pins and files are linked", () => {
    const pins = listPins(db, CH_GENERAL);
    expect(pins).toHaveLength(1);
    const pinned = getMessage(db, CH_GENERAL, pins[0].message_ts)!;
    expect(pinned.text).toContain("Welcome");

    const hist = getHistory(db, CH_ENG, { limit: 100 });
    const withFile = hist.find((m) => m.has_files === 1)!;
    const files = getFilesForMessage(db, CH_ENG, withFile.ts);
    expect(files).toHaveLength(1);
    expect(files[0].name).toContain("postmortem");
    expect(files[0].data).not.toBeNull();
  });

  it("FTS is populated and searchable", () => {
    const rows = db
      .prepare("SELECT channel_id, ts FROM messages_fts WHERE messages_fts MATCH ?")
      .all('"khachapuri"') as Array<{ channel_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].channel_id).toBe("C0RANDOM001");
  });

  it("is reproducible (same counts run-to-run)", () => {
    const db2 = makeSeededDb();
    const count = (d: Database.Database, t: string) =>
      (d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    for (const t of ["users", "conversations", "messages", "reactions", "pins"]) {
      expect(count(db2, t)).toBe(count(db, t));
    }
  });
});
