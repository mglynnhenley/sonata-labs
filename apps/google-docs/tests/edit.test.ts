import { describe, expect, it } from "vitest";
import {
  createNamedRange,
  deleteContentRange,
  insertText,
  replaceAllText,
  updateParagraphStyle,
} from "@/lib/docs/edit";
import { layout } from "@/lib/docs/index-space";
import { plainText, type DocModel } from "@/lib/docs/shape";
import { makeModel } from "./helpers";

// The five mutations, over bare models. Every assertion is about what an agent
// would read back, not about the shape of the rows underneath.

function text(model: DocModel): string {
  return plainText(model);
}

/**
 * Iterating a string yields code POINTS, so a well-formed pair arrives as one
 * character above U+FFFF and only a stranded half is left looking like a
 * surrogate. Anything this finds would reach SQLite, be written as UTF-8, and
 * read back to the agent as U+FFFD.
 */
function hasLoneSurrogate(s: string): boolean {
  return [...s].some((ch) => {
    const code = ch.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  });
}

/** "a 😄 b": indexes 1..2 are "a ", the emoji is 3 and 4, then " b\n". */
const EMOJI_PARAGRAPH = "a 😄 b";

describe("insertText", () => {
  it("prepends at index 1 and shifts everything after it by the length", () => {
    const model = makeModel([{ text: "Hello" }, { text: "World" }]);
    const before = layout(model).paragraphs[1].startIndex;
    insertText(model, 0, { text: "Say ", location: { index: 1 } });
    expect(text(model)).toBe("Say Hello\nWorld\n");
    expect(layout(model).paragraphs[1].startIndex).toBe(before + 4);
  });

  it("inherits the preceding run's style inside a paragraph", () => {
    const model = makeModel([{ runs: [{ content: "plain" }, { content: "bold", bold: true }] }]);
    // Index 6 is one past "plain"'s first character, i.e. inside the plain run.
    insertText(model, 0, { text: "XX", location: { index: 6 } });
    const runs = model.paragraphs[0].runs;
    expect(runs[0].content).toBe("plainXX");
    expect(runs[0].style).toBeNull();
  });

  it("inherits the first run's style at a paragraph start", () => {
    const model = makeModel([{ runs: [{ content: "bold", bold: true }] }]);
    insertText(model, 0, { text: "X", location: { index: 1 } });
    expect(model.paragraphs[0].runs[0]).toMatchObject({ content: "Xbold\n", style: { bold: true } });
  });

  it("splits one paragraph into two when the text contains a newline", () => {
    const model = makeModel([{ style: "HEADING_1", text: "AB" }]);
    const headingId = model.paragraphs[0].headingId;
    insertText(model, 0, { text: "X\nY", location: { index: 2 } });
    expect(text(model)).toBe("AX\nYB\n");
    expect(model.paragraphs).toHaveLength(2);
    // Both keep the paragraph style; the heading id stays on the first only,
    // because one id must not name two anchors.
    expect(model.paragraphs.map((p) => p.namedStyleType)).toEqual(["HEADING_1", "HEADING_1"]);
    expect(model.paragraphs[0].headingId).toBe(headingId);
    expect(model.paragraphs[1].headingId).toBeNull();
  });

  it("appends immediately before the body's final newline with endOfSegmentLocation", () => {
    const model = makeModel([{ text: "One" }, { text: "Two" }]);
    insertText(model, 0, { text: "\nThree", endOfSegmentLocation: {} });
    expect(text(model)).toBe("One\nTwo\nThree\n");
  });

  it("rejects index 0 and the document's end with the vendor's bounds message", () => {
    const model = makeModel([{ text: "Hi" }]);
    const end = layout(model).endIndex;
    for (const index of [0, end]) {
      expect(() => insertText(model, 0, { text: "x", location: { index } })).toThrow(
        "Invalid requests[0].insertText: The insertion index must be inside the bounds of an existing paragraph.",
      );
    }
  });

  it("rejects an empty insert and a non-empty segmentId", () => {
    const model = makeModel([{ text: "Hi" }]);
    expect(() => insertText(model, 2, { text: "", location: { index: 1 } })).toThrow(
      "Invalid requests[2].insertText: The text to insert cannot be empty.",
    );
    expect(() =>
      insertText(model, 0, { text: "x", location: { index: 1, segmentId: "h.1" } }),
    ).toThrow(/segmentId must be empty/);
  });

  it("nudges an insert aimed between an emoji's two halves past it, as the vendor does", () => {
    const model = makeModel([{ text: EMOJI_PARAGRAPH }]);
    insertText(model, 0, { text: "X", location: { index: 4 } });
    expect(text(model)).toBe("a 😄X b\n");
    expect(hasLoneSurrogate(text(model))).toBe(false);
  });

  it("leaves an insert on either side of an emoji exactly where it was asked for", () => {
    const before = makeModel([{ text: EMOJI_PARAGRAPH }]);
    insertText(before, 0, { text: "X", location: { index: 3 } });
    expect(text(before)).toBe("a X😄 b\n");
    const after = makeModel([{ text: EMOJI_PARAGRAPH }]);
    insertText(after, 0, { text: "X", location: { index: 5 } });
    expect(text(after)).toBe("a 😄X b\n");
  });

  it("strips control characters but keeps tab and newline", () => {
    const model = makeModel([{ text: "" }]);
    insertText(model, 0, { text: "ab\tc\nd", location: { index: 1 } });
    expect(text(model)).toBe("ab\tc\nd\n");
  });
});

describe("deleteContentRange", () => {
  it("removes exactly the span", () => {
    const model = makeModel([{ text: "abcdef" }]);
    deleteContentRange(model, 0, { range: { startIndex: 2, endIndex: 5 } });
    expect(text(model)).toBe("aef\n");
  });

  it("merges two paragraphs when the newline between them goes, first style winning", () => {
    const model = makeModel([{ style: "HEADING_1", text: "Head" }, { text: "Body" }]);
    // "Head\n" occupies [1,6); index 5 is its newline.
    deleteContentRange(model, 0, { range: { startIndex: 5, endIndex: 6 } });
    expect(text(model)).toBe("HeadBody\n");
    expect(model.paragraphs).toHaveLength(1);
    expect(model.paragraphs[0].namedStyleType).toBe("HEADING_1");
  });

  it("refuses to touch the section break", () => {
    const model = makeModel([{ text: "abc" }]);
    expect(() => deleteContentRange(model, 1, { range: { startIndex: 0, endIndex: 2 } })).toThrow(
      "Invalid requests[1].deleteContentRange: The range cannot include the section break at the start of the body.",
    );
  });

  it("refuses to delete the body's last newline", () => {
    const model = makeModel([{ text: "abc" }]);
    const end = layout(model).endIndex;
    expect(() => deleteContentRange(model, 0, { range: { startIndex: 1, endIndex: end } })).toThrow(
      "Invalid requests[0].deleteContentRange: The last newline character of the body cannot be deleted.",
    );
  });

  it("refuses an empty range", () => {
    const model = makeModel([{ text: "abc" }]);
    expect(() => deleteContentRange(model, 0, { range: { startIndex: 2, endIndex: 2 } })).toThrow(
      "Invalid requests[0].deleteContentRange: The range must not be empty.",
    );
  });

  it("refuses a range that splits a surrogate pair at either end", () => {
    const model = makeModel([{ text: EMOJI_PARAGRAPH }]);
    for (const range of [{ startIndex: 4, endIndex: 6 }, { startIndex: 2, endIndex: 4 }]) {
      expect(() => deleteContentRange(model, 0, { range })).toThrow(
        "Invalid requests[0].deleteContentRange: The range cannot split a surrogate pair.",
      );
    }
    expect(text(model)).toBe("a 😄 b\n");
  });

  it("deletes an emoji whole when the range covers both of its indexes", () => {
    const model = makeModel([{ text: EMOJI_PARAGRAPH }]);
    deleteContentRange(model, 0, { range: { startIndex: 3, endIndex: 5 } });
    expect(text(model)).toBe("a  b\n");
  });

  it("can never leave a lone surrogate behind, at any index of any range", () => {
    // The property the two cases above sample: swept over every insert point and
    // every range in a document that contains an emoji, because a guard that
    // holds at the indexes a test author thought of is not a guard.
    const end = layout(makeModel([{ text: EMOJI_PARAGRAPH }])).endIndex;
    for (let index = 1; index < end; index++) {
      const model = makeModel([{ text: EMOJI_PARAGRAPH }]);
      insertText(model, 0, { text: "X", location: { index } });
      expect(hasLoneSurrogate(text(model))).toBe(false);
    }
    for (let startIndex = 1; startIndex < end - 1; startIndex++) {
      for (let endIndex = startIndex + 1; endIndex < end; endIndex++) {
        const model = makeModel([{ text: EMOJI_PARAGRAPH }]);
        try {
          deleteContentRange(model, 0, { range: { startIndex, endIndex } });
        } catch (err) {
          expect((err as Error).message).toMatch(/cannot split a surrogate pair/);
          continue;
        }
        expect(hasLoneSurrogate(text(model))).toBe(false);
      }
    }
  });
});

describe("replaceAllText", () => {
  it("replaces every occurrence and returns the count", () => {
    const model = makeModel([{ text: "x [[N]] y [[N]]" }, { text: "and [[N]]" }]);
    expect(replaceAllText(model, 0, { containsText: { text: "[[N]]" }, replaceText: "7" })).toBe(3);
    expect(text(model)).toBe("x 7 y 7\nand 7\n");
  });

  it("is case-insensitive by default and exact with matchCase", () => {
    const insensitive = makeModel([{ text: "Alpha alpha" }]);
    expect(
      replaceAllText(insensitive, 0, { containsText: { text: "alpha" }, replaceText: "beta" }),
    ).toBe(2);
    const sensitive = makeModel([{ text: "Alpha alpha" }]);
    expect(
      replaceAllText(sensitive, 0, {
        containsText: { text: "alpha", matchCase: true },
        replaceText: "beta",
      }),
    ).toBe(1);
    expect(text(sensitive)).toBe("Alpha beta\n");
  });

  it("never matches across a paragraph boundary", () => {
    const model = makeModel([{ text: "one" }, { text: "two" }]);
    expect(replaceAllText(model, 0, { containsText: { text: "one\ntwo" }, replaceText: "x" })).toBe(0);
    expect(text(model)).toBe("one\ntwo\n");
  });

  it("deletes the match when replaceText is empty", () => {
    const model = makeModel([{ text: "keep DROP this" }]);
    expect(replaceAllText(model, 0, { containsText: { text: "DROP " }, replaceText: "" })).toBe(1);
    expect(text(model)).toBe("keep this\n");
  });

  it("shifts a named range after the replacement by the net delta", () => {
    const model = makeModel([{ text: "aa[[N]]bb" }]);
    const end = layout(model).endIndex;
    model.namedRanges = [{ id: "kix.x", name: "tail", startIndex: end - 3, endIndex: end - 1 }];
    replaceAllText(model, 0, { containsText: { text: "[[N]]" }, replaceText: "1" });
    // "[[N]]" (5) became "1" (1): everything after moves left by four.
    expect(model.namedRanges[0]).toMatchObject({ startIndex: end - 7, endIndex: end - 5 });
  });

  it("replaces a match that ends on the document's last character", () => {
    // The riskiest boundary: the delete this runs internally must not look like
    // an attempt to eat the body's final newline.
    const model = makeModel([{ text: "keep DROP" }]);
    expect(replaceAllText(model, 0, { containsText: { text: "DROP" }, replaceText: "KEPT" })).toBe(1);
    expect(text(model)).toBe("keep KEPT\n");
  });

  it("does not match half of an emoji", () => {
    // A needle can carry a lone surrogate, and code-unit comparison would happily
    // line it up with one half of a pair. Answering "no occurrences" is the only
    // honest reply: the alternative is a 400 naming deleteContentRange, which the
    // agent never sent.
    const model = makeModel([{ text: EMOJI_PARAGRAPH }]);
    expect(replaceAllText(model, 0, { containsText: { text: "\uDE04" }, replaceText: "!" })).toBe(0);
    expect(text(model)).toBe("a 😄 b\n");
  });

  it("rejects an empty needle", () => {
    const model = makeModel([{ text: "abc" }]);
    expect(() => replaceAllText(model, 3, { containsText: { text: "" }, replaceText: "x" })).toThrow(
      "Invalid requests[3].replaceAllText: The text to find cannot be empty.",
    );
  });
});

describe("updateParagraphStyle", () => {
  const style = (model: DocModel, startIndex: number, endIndex: number, named: string): void =>
    updateParagraphStyle(model, 0, {
      range: { startIndex, endIndex },
      paragraphStyle: { namedStyleType: named },
      fields: "namedStyleType",
    });

  it("styles every paragraph overlapping the range and no others", () => {
    const model = makeModel([{ text: "one" }, { text: "two" }, { text: "three" }]);
    const l = layout(model);
    style(model, l.paragraphs[0].endIndex - 1, l.paragraphs[1].startIndex + 1, "HEADING_2");
    expect(model.paragraphs.map((p) => p.namedStyleType)).toEqual([
      "HEADING_2",
      "HEADING_2",
      "NORMAL_TEXT",
    ]);
  });

  it("styles the paragraph containing a collapsed range", () => {
    const model = makeModel([{ text: "one" }, { text: "two" }]);
    const at = layout(model).paragraphs[1].startIndex;
    style(model, at, at, "HEADING_1");
    expect(model.paragraphs.map((p) => p.namedStyleType)).toEqual(["NORMAL_TEXT", "HEADING_1"]);
  });

  it("mints a headingId on a heading and clears it on NORMAL_TEXT", () => {
    const model = makeModel([{ text: "one" }]);
    style(model, 1, 1, "HEADING_1");
    expect(model.paragraphs[0].headingId).toMatch(/^h\.[a-z0-9]{12}$/);
    style(model, 1, 1, "NORMAL_TEXT");
    expect(model.paragraphs[0].headingId).toBeNull();
  });

  it("sets and clears alignment through the field mask", () => {
    const model = makeModel([{ text: "one" }]);
    updateParagraphStyle(model, 0, {
      range: { startIndex: 1, endIndex: 1 },
      paragraphStyle: { alignment: "CENTER" },
      fields: "alignment",
    });
    expect(model.paragraphs[0].alignment).toBe("CENTER");
    updateParagraphStyle(model, 0, {
      range: { startIndex: 1, endIndex: 1 },
      paragraphStyle: {},
      fields: "alignment",
    });
    expect(model.paragraphs[0].alignment).toBeNull();
  });

  it("requires a field mask and rejects an unsupported entry", () => {
    const model = makeModel([{ text: "one" }]);
    expect(() =>
      updateParagraphStyle(model, 0, { range: { startIndex: 1, endIndex: 1 }, fields: "" }),
    ).toThrow("Invalid requests[0].updateParagraphStyle: The field mask is required.");
    expect(() =>
      updateParagraphStyle(model, 0, {
        range: { startIndex: 1, endIndex: 1 },
        paragraphStyle: {},
        fields: "indentStart",
      }),
    ).toThrow(/got "indentStart"/);
  });

  it("rejects an unknown namedStyleType by naming the valid set", () => {
    const model = makeModel([{ text: "one" }]);
    expect(() => style(model, 1, 1, "HEADING_9")).toThrow(/namedStyleType must be one of/);
  });
});

describe("createNamedRange", () => {
  it("mints a kix-shaped id", () => {
    const model = makeModel([{ text: "abcdef" }]);
    const id = createNamedRange(model, 0, { name: "Evidence owners", range: { startIndex: 1, endIndex: 4 } });
    expect(id).toMatch(/^kix\.[a-z0-9]{12}$/);
    expect(model.namedRanges).toHaveLength(1);
  });

  it("rejects an empty name and an inverted range", () => {
    const model = makeModel([{ text: "abcdef" }]);
    expect(() => createNamedRange(model, 0, { name: "", range: { startIndex: 1, endIndex: 4 } })).toThrow(
      "Invalid requests[0].createNamedRange: The name cannot be empty.",
    );
    expect(() =>
      createNamedRange(model, 0, { name: "x", range: { startIndex: 4, endIndex: 2 } }),
    ).toThrow("Invalid requests[0].createNamedRange: The range must not be empty.");
  });
});
