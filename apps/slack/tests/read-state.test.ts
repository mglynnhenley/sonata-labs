import { describe, it, expect, beforeEach } from "vitest";
import { makeSeededDb } from "./helpers";
import {
  unreadCounts,
  setLastRead,
  getLastRead,
  markAllRead,
  totalMentions,
  ZERO_TS,
} from "@/lib/store/read-state";
import { insertMessage, getHistory } from "@/lib/store/messages";
import { mintTs } from "@/lib/slack/ts";
import { CH_ENG, DM_PRIYA, ME } from "@/lib/seed";
import type Database from "better-sqlite3";

let db: Database.Database;
beforeEach(() => {
  db = makeSeededDb();
});

function post(channel: string, user: string, text: string, threadTs?: string) {
  const ts = mintTs(db, channel);
  insertMessage(db, {
    channelId: channel,
    ts,
    threadTs: threadTs ?? null,
    user,
    text,
    rawJson: JSON.stringify({ type: "message", user, text, ts }),
  });
  return ts;
}

describe("read state", () => {
  it("defaults to everything unread", () => {
    const c = unreadCounts(db, CH_ENG, ME, { isDm: false });
    expect(c.lastRead).toBe(ZERO_TS);
    expect(c.unread).toBeGreaterThan(0);
  });

  it("markAllRead clears the count", () => {
    markAllRead(db, CH_ENG, ME);
    expect(unreadCounts(db, CH_ENG, ME, { isDm: false }).unread).toBe(0);
  });

  it("new messages become unread again", () => {
    markAllRead(db, CH_ENG, ME);
    post(CH_ENG, "U0PRIYA0001", "something new");
    expect(unreadCounts(db, CH_ENG, ME, { isDm: false }).unread).toBe(1);
  });

  it("your OWN messages never count as unread", () => {
    markAllRead(db, CH_ENG, ME);
    post(CH_ENG, ME, "my own message");
    expect(unreadCounts(db, CH_ENG, ME, { isDm: false }).unread).toBe(0);
  });

  it("thread replies do not bump the channel count", () => {
    markAllRead(db, CH_ENG, ME);
    const root = post(CH_ENG, "U0PRIYA0001", "root");
    expect(unreadCounts(db, CH_ENG, ME, { isDm: false }).unread).toBe(1);
    post(CH_ENG, "U0PRIYA0001", "a reply", root);
    // still 1: the reply belongs to the thread, not the channel badge
    expect(unreadCounts(db, CH_ENG, ME, { isDm: false }).unread).toBe(1);
  });

  it("channels badge only on mentions; DMs badge on everything", () => {
    markAllRead(db, CH_ENG, ME);
    markAllRead(db, DM_PRIYA, ME);

    post(CH_ENG, "U0PRIYA0001", "no mention here");
    const chan = unreadCounts(db, CH_ENG, ME, { isDm: false });
    expect(chan.unread).toBe(1);
    expect(chan.display).toBe(0); // unread, but no badge

    post(DM_PRIYA, "U0PRIYA0001", "hello");
    const dm = unreadCounts(db, DM_PRIYA, ME, { isDm: true });
    expect(dm.unread).toBe(1);
    expect(dm.display).toBe(1); // DMs always badge
  });

  it("counts direct @mentions", () => {
    markAllRead(db, CH_ENG, ME);
    post(CH_ENG, "U0PRIYA0001", `can <@${ME}> take a look?`);
    const c = unreadCounts(db, CH_ENG, ME, { isDm: false });
    expect(c.mentions).toBe(1);
    expect(c.display).toBe(1);
  });

  it("counts broadcast mentions (@here/@channel/@everyone)", () => {
    for (const kw of ["<!here>", "<!channel>", "<!everyone>"]) {
      const fresh = makeSeededDb();
      const ts = mintTs(fresh, CH_ENG);
      insertMessage(fresh, {
        channelId: CH_ENG,
        ts,
        user: "U0PRIYA0001",
        text: `${kw} heads up`,
        rawJson: "{}",
      });
      setLastRead(fresh, CH_ENG, ME, "0");
      const before = unreadCounts(fresh, CH_ENG, ME, { isDm: false });
      expect(before.mentions).toBeGreaterThanOrEqual(1);
    }
  });

  it("does not count a mention of someone else", () => {
    markAllRead(db, CH_ENG, ME);
    post(CH_ENG, "U0PRIYA0001", "<@U0JORDAN001> ping");
    expect(unreadCounts(db, CH_ENG, ME, { isDm: false }).mentions).toBe(0);
  });

  it("last_read is per user", () => {
    markAllRead(db, CH_ENG, ME);
    expect(unreadCounts(db, CH_ENG, ME, { isDm: false }).unread).toBe(0);
    expect(unreadCounts(db, CH_ENG, "U0JORDAN001", { isDm: false }).unread).toBeGreaterThan(0);
  });

  it("setLastRead to a mid-history ts leaves only newer messages unread", () => {
    const hist = getHistory(db, CH_ENG, { limit: 100 }); // newest first
    setLastRead(db, CH_ENG, ME, hist[2].ts);
    expect(getLastRead(db, CH_ENG, ME)).toBe(hist[2].ts);
    const c = unreadCounts(db, CH_ENG, ME, { isDm: false });
    // The two newer roots, minus any authored by ME.
    const newerNotMine = hist.slice(0, 2).filter((m) => m.user !== ME).length;
    expect(c.unread).toBe(newerNotMine);
  });

  it("totalMentions aggregates across conversations", () => {
    for (const c of ["C0GENERAL01", CH_ENG, DM_PRIYA, "C0RANDOM001", "G0LEADERSH1", "D0MJORDAN01", "G0MPIM00001"]) {
      markAllRead(db, c, ME);
    }
    expect(totalMentions(db, ME)).toBe(0);
    post(CH_ENG, "U0PRIYA0001", `<@${ME}> one`);
    post(DM_PRIYA, "U0PRIYA0001", "two");
    expect(totalMentions(db, ME)).toBe(2);
  });
});
