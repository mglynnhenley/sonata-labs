import { describe, expect, it } from "vitest";
import { layout } from "@/lib/docs/index-space";
import { plainText } from "@/lib/docs/shape";
import { BadRequestError } from "@/lib/sandbox/auth";
import { injectDocs } from "@/lib/sandbox/inject";
import { parseSeedRequest, parseWireParagraphs, toParagraphModels } from "@/lib/sandbox/parse";
import { captureTwinSnapshot } from "@/lib/sandbox/snapshot";
import { loadDocument } from "@/lib/store/documents";
import { ANCHOR_MS, CORPUS, makeTestDb, OWNER } from "./helpers";

// The control plane: the parser that establishes the index-space invariant for
// content authored outside this app, the director's beat, and the judge's view.

const WORLD = {
  business: { name: "Acme" },
  cast: [
    { id: "u_owner", name: "Sandbox User", email: OWNER },
    { id: "u_priya", name: "Priya Nair", email: "priya@acme.co" },
  ],
  mailboxOwner: OWNER,
};

function seedBody(documents: unknown[]): unknown {
  return {
    twin: "google-docs",
    seed: {
      world: WORLD,
      nowISO: new Date(ANCHOR_MS).toISOString(),
      ownerEmail: OWNER,
      documents,
    },
  };
}

const ONE_DOC = {
  id: "1SeededDocument0000000000000000000000000Ab",
  title: "Seeded brief",
  ownerEmail: OWNER,
  paragraphs: [{ namedStyleType: "HEADING_1", text: "Scope" }, { text: "One line." }],
};

describe("parseWireParagraphs", () => {
  it("puts the terminating newline on the LAST run and nowhere else", () => {
    const parsed = parseWireParagraphs(
      [{ runs: [{ content: "a" }, { content: "b", bold: true }] }],
      "p",
    );
    expect(parsed[0].runs.map((r) => r.content)).toEqual(["a", "b\n"]);
  });

  it("rejects a newline inside a run, because a paragraph break is a new entry", () => {
    expect(() => parseWireParagraphs([{ text: "one\ntwo" }], "p")).toThrow(/contains a newline/);
  });

  it("rejects a paragraph that sets both text and runs, or neither", () => {
    expect(() => parseWireParagraphs([{ text: "a", runs: [{ content: "b" }] }], "p")).toThrow(
      /either text or runs/,
    );
    expect(() => parseWireParagraphs([{}], "p")).toThrow(/either text or runs/);
  });

  it("rejects an empty paragraph list and an unknown named style", () => {
    expect(() => parseWireParagraphs([], "p")).toThrow(/at least one paragraph/);
    expect(() => parseWireParagraphs([{ namedStyleType: "HEADING_9", text: "x" }], "p")).toThrow(
      /is not a Docs named style/,
    );
  });

  it("turns bold, italic and link into a TextStyle, and plain runs into no style", () => {
    const models = toParagraphModels(
      parseWireParagraphs([{ runs: [{ content: "a" }, { content: "b", bold: true, link: "u" }] }], "p"),
    );
    expect(models[0].runs[0].style).toBeNull();
    expect(models[0].runs[1].style).toEqual({ bold: true, link: { url: "u" } });
  });
});

describe("parseSeedRequest", () => {
  it("accepts a well-formed seed", () => {
    const parsed = parseSeedRequest(seedBody([ONE_DOC]));
    expect(parsed.ownerName).toBe("Sandbox User");
    expect(parsed.documents[0].paragraphs).toHaveLength(2);
  });

  it("rejects a seed routed to the wrong twin", () => {
    expect(() => parseSeedRequest({ twin: "calendar", seed: {} })).toThrow(
      /this twin seeds 'google-docs'/,
    );
  });

  it("refuses an owner the cast has never heard of", () => {
    const body = seedBody([{ ...ONE_DOC, ownerEmail: "stranger@example.com" }]);
    expect(() => parseSeedRequest(body)).toThrow(/is not in seed.world.cast/);
  });

  it("refuses an id that is not a Google Docs id, and a duplicate one", () => {
    expect(() => parseSeedRequest(seedBody([{ ...ONE_DOC, id: "short" }]))).toThrow(
      /is not a Google Docs id/,
    );
    expect(() => parseSeedRequest(seedBody([ONE_DOC, ONE_DOC]))).toThrow(/share the id/);
  });
});

describe("injectDocs", () => {
  it("mints a document at simulated time and echoes the slotId back", () => {
    const db = makeTestDb();
    const result = injectDocs(db, {
      atMs: ANCHOR_MS,
      documents: [{ slotId: "brief-1", title: "New brief", paragraphs: [{ text: "Read me." }] }],
    });
    expect(result.documents[0].slotId).toBe("brief-1");
    const model = loadDocument(db, result.documents[0].documentId)!;
    expect(plainText(model)).toBe("Read me.\n");
  });

  it("appends a paragraph through the same insertText an agent would send", () => {
    const db = makeTestDb(CORPUS);
    const before = layout(loadDocument(db, CORPUS[0].id)!).endIndex;
    injectDocs(db, {
      atISO: new Date(ANCHOR_MS).toISOString(),
      edits: [
        {
          documentId: CORPUS[0].id,
          appendParagraphs: [{ namedStyleType: "HEADING_1", text: "Addendum" }],
        },
      ],
    });
    const after = loadDocument(db, CORPUS[0].id)!;
    expect(plainText(after).endsWith("Addendum\n")).toBe(true);
    expect(after.paragraphs[after.paragraphs.length - 1].namedStyleType).toBe("HEADING_1");
    // "\nAddendum" is nine code units.
    expect(layout(after).endIndex).toBe(before + 9);
  });

  it("replaces text and reports how many occurrences changed", () => {
    const db = makeTestDb(CORPUS);
    const result = injectDocs(db, {
      atMs: ANCHOR_MS,
      edits: [{ documentId: CORPUS[0].id, replace: [{ find: "[[HEADCOUNT]]", replaceWith: "6" }] }],
    });
    expect(result.edits[0].occurrencesChanged).toBe(2);
    expect(plainText(loadDocument(db, CORPUS[0].id)!)).toContain("We carry 6 roles, and 6 are");
  });

  it("mints a new revisionId for an edited document", () => {
    const db = makeTestDb(CORPUS);
    const before = loadDocument(db, CORPUS[0].id)!.revisionId;
    const result = injectDocs(db, {
      atMs: ANCHOR_MS,
      edits: [{ documentId: CORPUS[0].id, appendParagraphs: [{ text: "x" }] }],
    });
    expect(result.edits[0].revisionId).not.toBe(before);
  });

  it("refuses a beat with no simulated time, and one with nothing in it", () => {
    const db = makeTestDb(CORPUS);
    expect(() => injectDocs(db, { documents: [{ title: "t", paragraphs: [{ text: "x" }] }] })).toThrow(
      BadRequestError,
    );
    expect(() => injectDocs(db, { atMs: ANCHOR_MS })).toThrow("nothing to inject");
  });

  it("refuses an edit to a document that is not in the workspace", () => {
    const db = makeTestDb(CORPUS);
    expect(() =>
      injectDocs(db, { atMs: ANCHOR_MS, edits: [{ documentId: "nope", replace: [] }] }),
    ).toThrow(/is not a document in this workspace/);
  });

  it("writes no audit row — the director's moves are not the agent's", () => {
    const db = makeTestDb(CORPUS);
    injectDocs(db, {
      atMs: ANCHOR_MS,
      edits: [{ documentId: CORPUS[0].id, appendParagraphs: [{ text: "x" }] }],
    });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM audit.action_log").get() as { n: number }).n;
    expect(n).toBe(0);
  });
});

describe("captureTwinSnapshot", () => {
  it("reports the headings, the counts and the text the judge grades on", () => {
    const db = makeTestDb(CORPUS);
    const snap = captureTwinSnapshot(db);
    expect(snap.twin).toBe("google-docs");
    const doc = snap.documents[0];
    expect(doc.headings).toEqual(["Q3 Business Review — draft", "Headcount"]);
    expect(doc.paragraphCount).toBe(CORPUS[0].paragraphs.length);
    expect(doc.characterCount).toBe(layout(loadDocument(db, CORPUS[0].id)!).endIndex - 1);
    expect(doc.text).toContain("[[HEADCOUNT]]");
    expect(doc.truncated).toBe(false);
    expect(doc.isSandboxCreated).toBe(false);
  });

  it("names every named range on the document", () => {
    const db = makeTestDb(CORPUS);
    db.prepare(
      "INSERT INTO named_ranges (id, document_id, name, start_index, end_index) VALUES (?, ?, ?, ?, ?)",
    ).run("kix.aaaaaaaaaaaa", CORPUS[0].id, "Evidence owners", 1, 4);
    expect(captureTwinSnapshot(db).documents[0].namedRanges).toEqual(["Evidence owners"]);
  });
});
