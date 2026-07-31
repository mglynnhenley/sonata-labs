import { describe, it, expect } from "vitest";
import { makeSeededDb } from "./helpers";
import { searchMessages } from "@/lib/search/compile";
import { parseQuery } from "@/lib/search/parse";
import { insertConversation, addMember } from "@/lib/store/conversations";
import { insertMessage } from "@/lib/store/messages";
import { CH_ENG, CH_GENERAL, CH_RANDOM, ME } from "@/lib/seed";

// The seed is anchored to BASE = 2026-07-28T09:00:00Z; date cases below use
// UTC days around that anchor.

const db = makeSeededDb();

// A private channel WITHOUT self, to prove the visibility clause.
insertConversation(db, {
  id: "G0SECRETS01",
  name: "secrets",
  isGroup: true,
  isPrivate: true,
  creator: "U0PRIYA0001",
  created: 1700000000,
  rawJson: JSON.stringify({ id: "G0SECRETS01", name: "secrets", is_group: true, is_private: true }),
});
addMember(db, "G0SECRETS01", "U0PRIYA0001");
insertMessage(db, {
  channelId: "G0SECRETS01",
  ts: "1785000000.000001",
  user: "U0PRIYA0001",
  text: "the khachapuri launch is confidential",
  rawJson: "{}",
});

function run(q: string) {
  return searchMessages(db, q, ME, { count: 100, page: 1 });
}

interface Case {
  name: string;
  q: string;
  expect: (r: ReturnType<typeof run>) => void;
}

const CASES: Case[] = [
  // --- free text / phrases ---
  { name: "free text single hit", q: "khachapuri", expect: (r) => { expect(r.total).toBe(1); expect(r.matches[0].channel_id).toBe(CH_RANDOM); } },
  { name: "free text case-insensitive", q: "KHACHAPURI", expect: (r) => expect(r.total).toBe(1) },
  { name: "multi-term is AND", q: "deploy production", expect: (r) => { expect(r.total).toBeGreaterThan(0); r.matches.forEach((m) => { expect(m.text!.toLowerCase()).toContain("deploy"); expect(m.text!.toLowerCase()).toContain("production"); }); } },
  { name: "phrase must match adjacently", q: '"connection pool"', expect: (r) => { expect(r.total).toBe(1); expect(r.matches[0].text).toContain("connection pool"); } },
  { name: "phrase in wrong order misses", q: '"pool connection"', expect: (r) => expect(r.total).toBe(0) },
  { name: "no hits", q: "zyzzyva", expect: (r) => expect(r.total).toBe(0) },
  { name: "fts operators are neutralized", q: "AND OR NOT", expect: (r) => expect(r.total).toBe(0) },
  // --- in: ---
  { name: "in:#channel scopes", q: "in:#engineering rollback", expect: (r) => { expect(r.total).toBe(1); expect(r.matches[0].channel_id).toBe(CH_ENG); } },
  { name: "in: without #", q: "in:engineering rollback", expect: (r) => expect(r.total).toBe(1) },
  { name: "in: by raw id", q: `in:${CH_GENERAL} offsite`, expect: (r) => { expect(r.total).toBeGreaterThan(0); r.matches.forEach((m) => expect(m.channel_id).toBe(CH_GENERAL)); } },
  { name: "in: unknown channel matches nothing", q: "in:#nonexistent deploy", expect: (r) => expect(r.total).toBe(0) },
  { name: "in:@user scopes to that DM", q: "in:@priya demo", expect: (r) => { expect(r.total).toBeGreaterThan(0); r.matches.forEach((m) => expect(m.channel_id).toBe("D0MPRIYA001")); } },
  { name: "-in: negates", q: "-in:#random khachapuri", expect: (r) => expect(r.total).toBe(0) },
  // --- from: ---
  { name: "from:@user", q: "from:@alex 5xx", expect: (r) => { expect(r.total).toBeGreaterThan(0); r.matches.forEach((m) => expect(m.user).toBe("U0ALEX00001")); } },
  { name: "from: without @", q: "from:alex postmortem", expect: (r) => expect(r.total).toBeGreaterThan(0) },
  { name: "from: by raw id", q: "from:U0JORDAN001 checkout", expect: (r) => expect(r.total).toBe(1) },
  { name: "from: unknown user matches nothing", q: "from:@nobody deploy", expect: (r) => expect(r.total).toBe(0) },
  { name: "-from: negates", q: "in:#engineering -from:@alex 5xx", expect: (r) => expect(r.total).toBe(0) },
  { name: "in: AND from: intersect", q: "in:#general from:@priya offsite", expect: (r) => { expect(r.total).toBe(1); expect(r.matches[0].user).toBe("U0PRIYA0001"); } },
  // --- has: ---
  { name: "has:reaction", q: "has:reaction", expect: (r) => { expect(r.total).toBeGreaterThan(5); } },
  { name: "has:file", q: "has:file", expect: (r) => { expect(r.total).toBe(1); expect(r.matches[0].has_files).toBe(1); } },
  { name: "has:pin", q: "has:pin", expect: (r) => { expect(r.total).toBe(1); expect(r.matches[0].text).toContain("Welcome"); } },
  { name: "has:link finds nothing in seed", q: "has:link", expect: (r) => expect(r.total).toBe(0) },
  { name: "has: combined with text", q: "has:reaction wrapped? no — offsite", expect: (r) => r.matches.forEach((m) => expect(m.channel_id).toBe(CH_GENERAL)) },
  // --- dates (UTC; BASE = 2026-07-28) ---
  { name: "before: excludes the day itself", q: "before:2026-07-28 khachapuri", expect: (r) => expect(r.total).toBe(1) }, // 60*23 min ago = 2026-07-27
  { name: "before: cuts off recent", q: "before:2026-07-27 khachapuri", expect: (r) => expect(r.total).toBe(0) },
  { name: "after: starts next day", q: "after:2026-07-27 demo in:#general", expect: (r) => r.matches.forEach((m) => expect(Number(m.ts.split(".")[0])).toBeGreaterThanOrEqual(Date.UTC(2026, 6, 28) / 1000)) },
  { name: "on: brackets one day", q: "on:2026-07-27 khachapuri", expect: (r) => expect(r.total).toBe(1) },
  { name: "during: month", q: "during:2026-07 khachapuri", expect: (r) => expect(r.total).toBe(1) },
  { name: "during: wrong month", q: "during:2026-06 khachapuri", expect: (r) => expect(r.total).toBe(0) },
  { name: "bad date degrades to text (no match)", q: "before:notadate", expect: (r) => expect(r.total).toBe(0) },
  // --- unknown modifiers degrade, never throw ---
  { name: "unknown modifier degrades to text", q: "foo:bar", expect: (r) => expect(r.total).toBe(0) },
  { name: "unknown modifier alongside real one", q: "in:#engineering wibble:wobble", expect: (r) => expect(r.total).toBe(0) },
  // --- visibility ---
  { name: "private channel without self is invisible", q: "confidential", expect: (r) => expect(r.total).toBe(0) },
  { name: "private channel WITH self is searchable", q: "headcount", expect: (r) => { expect(r.total).toBe(1); expect(r.matches[0].channel_id).toBe("G0LEADERSH1"); } },
];

describe("search", () => {
  for (const c of CASES) {
    it(c.name, () => c.expect(run(c.q)));
  }

  it("parser handles quoted modifier values", () => {
    const terms = parseQuery('from:"Priya Nair" "exact phrase" -in:#random plain');
    expect(terms).toEqual([
      { kind: "modifier", field: "from", value: "Priya Nair", negated: false },
      { kind: "text", value: "exact phrase", phrase: true, negated: false },
      { kind: "modifier", field: "in", value: "#random", negated: true },
      { kind: "text", value: "plain", phrase: false, negated: false },
    ]);
  });

  it("paging slices and counts correctly", () => {
    const page1 = searchMessages(db, "has:reaction", ME, { count: 3, page: 1 });
    const page2 = searchMessages(db, "has:reaction", ME, { count: 3, page: 2 });
    expect(page1.matches).toHaveLength(3);
    expect(page1.total).toBe(page2.total);
    const ids1 = new Set(page1.matches.map((m) => `${m.channel_id}/${m.ts}`));
    page2.matches.forEach((m) => expect(ids1.has(`${m.channel_id}/${m.ts}`)).toBe(false));
    // newest-first across the full set
    expect(page1.matches[0].ts > page1.matches[2].ts).toBe(true);
  });
});
