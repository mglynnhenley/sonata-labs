import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Database } from "better-sqlite3";
import { makeTestDb, CORPUS, NOW } from "./helpers";
import { compileQuery } from "@/lib/search/compile";
import { listMessages } from "@/lib/store/messages";

let db: Database;
beforeAll(() => {
  db = makeTestDb(CORPUS);
});
afterAll(() => db.close());

/** Run a query and return matching ids (sorted for stable comparison). */
function search(q: string, includeSpamTrash = false): string[] {
  const clause = compileQuery(db, q, { now: NOW });
  const res = listMessages(db, {
    search: clause,
    includeSpamTrash,
    offset: 0,
    limit: 100,
  });
  return res.ids.map((r) => r.id).sort();
}

describe("search compiler", () => {
  const cases: Array<[string, string, string[]]> = [
    // [description, query, expected ids]
    ["from: matches sender", "from:priya", ["aaa1"]],
    ["from: is substring + case-insensitive on value via LIKE", "from:github", ["aaa2"]],
    ["to: matches recipient", "to:priya@acme.co", ["aaa4"]],
    ["subject: matches (incl. the reply)", "subject:quarterly", ["aaa1", "aaa4"]],
    ["subject: phrase (incl. the reply)", 'subject:"Quarterly report"', ["aaa1", "aaa4"]],
    ["free text hits body via FTS", "revenue", ["aaa1"]],
    ["free text hits subject via FTS", "Lisbon", ["aaa7"]],
    ["multi free text is AND", "race condition", ["aaa2"]],
    ["phrase free text", '"foldable phone"', ["aaa3"]],
    ["label: by user name (case-insensitive)", "label:work", ["aaa1"]],
    ["label: travel", "label:Travel", ["aaa7"]],
    ["in:inbox", "in:inbox", ["aaa1", "aaa2", "aaa3", "aaa7"]],
    ["is:unread", "is:unread", ["aaa1"]],
    ["is:starred", "is:starred", ["aaa1"]],
    ["is:important", "is:important", ["aaa2"]],
    ["has:attachment", "has:attachment", ["aaa7"]],
    ["is:read excludes unread", "is:read in:inbox", ["aaa2", "aaa3", "aaa7"]],
    ["negation -from", "in:inbox -from:priya", ["aaa2", "aaa3", "aaa7"]],
    ["combined operators", "in:inbox is:unread", ["aaa1"]],
    ["after: date excludes older", "after:2026/07/25", ["aaa1", "aaa2"]],
    ["before: date", "before:2026/07/22", ["aaa4", "aaa7"]],
    ["newer_than:3d", "newer_than:3d", ["aaa1", "aaa2"]],
    ["older_than:30d", "older_than:30d in:trash", ["aaa6"]],
    ["unknown operator degrades to free text (literal, no crash)", "foo:bar", []],
  ];

  for (const [desc, q, expected] of cases) {
    it(desc, () => {
      // spam/trash queries need includeSpamTrash unless in:trash/spam is present
      const needsSpamTrash = /prize|claim/.test(q);
      expect(search(q, needsSpamTrash)).toEqual(expected.sort());
    });
  }

  it("default listing excludes TRASH and SPAM", () => {
    const all = search("in:inbox");
    expect(all).not.toContain("aaa5"); // spam
    expect(all).not.toContain("aaa6"); // trash
  });

  it("in:trash disables trash exclusion and matches trashed", () => {
    expect(search("in:trash")).toEqual(["aaa6"]);
  });

  it("in:spam matches spam", () => {
    expect(search("in:spam")).toEqual(["aaa5"]);
  });

  it("empty query compiles to null (no filter)", () => {
    expect(compileQuery(db, "", { now: NOW })).toBeNull();
  });

  it("unknown label matches nothing, never throws", () => {
    expect(search("label:doesnotexist")).toEqual([]);
  });

  it("FTS operator characters do not throw", () => {
    expect(() => search('subject:"a OR b" AND* weird(')).not.toThrow();
  });
});
