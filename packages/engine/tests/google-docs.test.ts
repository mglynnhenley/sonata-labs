import { describe, it, expect } from "vitest";
import type { GoogleDocsSnapshot } from "@sonata/core";
import { diffGoogleDocs, renderGoogleDocsDiff } from "../src/adapters/google-docs";

// The docs diff, offline. This is the half of the adapter an old artifact is
// re-judged through months after the twin that produced it stopped running, so
// it is worth holding to two captures and no server: everything below is the
// pure pass, and the live half is exercised by the acceptance run against a
// twin on 3600.

type Doc = GoogleDocsSnapshot["documents"][number];

const snap = (documents: Doc[]): GoogleDocsSnapshot => ({
  twin: "google-docs",
  capturedAt: 0,
  documents,
});

const doc = (over: Partial<Doc> & { documentId: string }): Doc => ({
  title: "Brief",
  revisionId: "r1",
  ownerEmail: "chris@momentum.test",
  excerpt: "",
  characterCount: 0,
  ...over,
});

const body = (text: string, over: Partial<Doc> & { documentId: string }): Doc =>
  doc({ excerpt: text, characterCount: text.length, ...over });

describe("google-docs diff", () => {
  it("reports a placeholder swap as the words that changed", () => {
    const before = snap([body("Owner: TBD\nDue: Friday\n", { documentId: "d1" })]);
    const after = snap([
      body("Owner: Priya Raman\nDue: Friday\n", { documentId: "d1", revisionId: "r2" }),
    ]);
    expect(diffGoogleDocs(before, after).edited).toEqual([
      {
        documentId: "d1",
        title: "Brief",
        ownerEmail: "chris@momentum.test",
        charactersAdded: 11,
        charactersRemoved: 3,
        excerpt: "Priya Raman",
      },
    ]);
  });

  it("names what went when an edit only deletes", () => {
    const before = snap([body("Keep this. Drop that.\n", { documentId: "d1" })]);
    const after = snap([body("Keep this.\n", { documentId: "d1", revisionId: "r2" })]);
    expect(diffGoogleDocs(before, after).edited[0]).toMatchObject({
      charactersAdded: 0,
      charactersRemoved: 11,
      excerpt: "[deleted] Drop that.",
    });
  });

  it("reports a revision with no text behind it rather than losing it", () => {
    const before = snap([body("Risks\n", { documentId: "d1" })]);
    const after = snap([body("Risks\n", { documentId: "d1", revisionId: "r2" })]);
    const diff = diffGoogleDocs(before, after);
    expect(diff.edited[0]).toMatchObject({ charactersAdded: 0, charactersRemoved: 0 });
    expect(diff.edited[0].excerpt).toMatch(/styling or structure/);
    expect(diff.unchangedCount).toBe(0);
  });

  it("counts the untouched and never lists them", () => {
    const docs = [body("a\n", { documentId: "d1" }), body("b\n", { documentId: "d2" })];
    expect(diffGoogleDocs(snap(docs), snap(docs))).toEqual({
      twin: "google-docs",
      created: [],
      edited: [],
      renamed: [],
      unchangedCount: 2,
    });
  });

  it("falls back to the reported length when the capture was truncated", () => {
    const head = "x".repeat(20);
    const before = snap([doc({ documentId: "d1", excerpt: head, characterCount: 500 })]);
    const after = snap([
      doc({ documentId: "d1", excerpt: head, characterCount: 620, revisionId: "r2" }),
    ]);
    const [edit] = diffGoogleDocs(before, after).edited;
    expect(edit).toMatchObject({ charactersAdded: 120, charactersRemoved: 0 });
    expect(edit.excerpt).toMatch(/falls past the first 20 characters/);
    // The counts are the twin's net figure here, and the row has to say so —
    // read as exact, 120 would understate a rewrite that also deleted.
    expect(edit.approximate).toBe(true);
  });

  it("shows the diverging head when a truncated capture changed inside it", () => {
    const before = snap([doc({ documentId: "d1", excerpt: "Owner: TBD  ", characterCount: 900 })]);
    const after = snap([
      doc({ documentId: "d1", excerpt: "Owner: Priya", characterCount: 902, revisionId: "r2" }),
    ]);
    expect(diffGoogleDocs(before, after).edited[0]).toMatchObject({
      charactersAdded: 2,
      charactersRemoved: 0,
      excerpt: "Priya",
    });
  });

  it("never cuts an excerpt through a surrogate pair", () => {
    const before = snap([body("ship it 🚚 today\n", { documentId: "d1" })]);
    const after = snap([body("ship it 🚀 today\n", { documentId: "d1", revisionId: "r2" })]);
    const [edit] = diffGoogleDocs(before, after).edited;
    expect(edit.excerpt).toBe("🚀");
    expect(edit.excerpt).not.toMatch(/�/);
    expect([...edit.excerpt].length).toBe(1);
  });

  it("says whose document moved, not just which one", () => {
    // The distinction the section exists for: an agent revising its own draft
    // and an agent rewriting a colleague's brief leave the same row otherwise.
    const before = snap([
      body("Owner: TBD\n", { documentId: "d1", ownerEmail: "priya@momentum.test" }),
    ]);
    const after = snap([
      body("Owner: Sam\n", {
        documentId: "d1",
        ownerEmail: "priya@momentum.test",
        revisionId: "r2",
      }),
    ]);
    expect(diffGoogleDocs(before, after).edited[0]?.ownerEmail).toBe("priya@momentum.test");
  });

  it("renders as prose a person can check", () => {
    const before = snap([body("Owner: TBD\n", { documentId: "d1", title: "Draft" })]);
    const after = snap([
      body("Owner: Sam\n", { documentId: "d1", title: "Final", revisionId: "r2" }),
      body("New\n", { documentId: "d2", title: "Handover", ownerEmail: "priya@momentum.test" }),
    ]);
    expect(renderGoogleDocsDiff(diffGoogleDocs(before, after))).toBe(
      [
        '+ created "Handover" owned by priya@momentum.test',
        '~ renamed "Draft" → "Final"',
        '~ edited "Final" (chris@momentum.test) +3/-3 characters — Sam',
        "0 document(s) untouched",
      ].join("\n"),
    );
  });
});
