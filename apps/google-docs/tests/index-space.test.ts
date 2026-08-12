import { describe, expect, it } from "vitest";
import {
  canonicalStyleJson,
  layout,
  normalise,
  paragraphAt,
  shiftNamedRanges,
} from "@/lib/docs/index-space";
import type { DocModel } from "@/lib/docs/shape";
import { makeModel } from "./helpers";

// The index arithmetic, over bare models. This is the suite that makes the clone
// worth building: everything batchUpdate does is expressed in these numbers.

function withRanges(model: DocModel, ranges: Array<[number, number]>): DocModel {
  model.namedRanges = ranges.map(([startIndex, endIndex], i) => ({
    id: `kix.range${i}`,
    name: `r${i}`,
    startIndex,
    endIndex,
  }));
  return model;
}

describe("layout", () => {
  it("lays a blank document out as [0,1) section break and [1,2) paragraph", () => {
    const l = layout(makeModel([{ text: "" }]));
    expect(l.sectionBreakEndIndex).toBe(1);
    expect(l.paragraphs).toHaveLength(1);
    expect(l.paragraphs[0]).toMatchObject({ startIndex: 1, endIndex: 2, text: "\n" });
    expect(l.endIndex).toBe(2);
  });

  it("starts paragraph 0 at 1 and every later one at its predecessor's endIndex", () => {
    const l = layout(makeModel([{ text: "Hello" }, { text: "World" }, { text: "!" }]));
    expect(l.paragraphs[0].startIndex).toBe(1);
    for (let k = 1; k < l.paragraphs.length; k++) {
      expect(l.paragraphs[k].startIndex).toBe(l.paragraphs[k - 1].endIndex);
    }
  });

  it("counts the trailing newline in a paragraph's endIndex", () => {
    // "Hello" is five characters and the paragraph spans six indexes.
    const l = layout(makeModel([{ text: "Hello" }]));
    expect(l.paragraphs[0].endIndex - l.paragraphs[0].startIndex).toBe(6);
  });

  it("ends at 1 + the sum of every paragraph's text length", () => {
    const model = makeModel([{ text: "one" }, { text: "twotwo" }, { text: "" }]);
    const total = model.paragraphs.reduce(
      (n, p) => n + p.runs.reduce((m, r) => m + r.content.length, 0),
      0,
    );
    expect(layout(model).endIndex).toBe(1 + total);
  });

  it("tiles a paragraph exactly with its run spans", () => {
    const p = layout(
      makeModel([{ runs: [{ content: "aa" }, { content: "bb", bold: true }, { content: "cc" }] }]),
    ).paragraphs[0];
    expect(p.runs[0].startIndex).toBe(p.startIndex);
    for (let k = 1; k < p.runs.length; k++) {
      expect(p.runs[k].startIndex).toBe(p.runs[k - 1].endIndex);
    }
    expect(p.runs[p.runs.length - 1].endIndex).toBe(p.endIndex);
  });

  it("charges an emoji two indexes, because the unit is UTF-16 code units", () => {
    // "a😄b\n" is 5 code units even though it is 4 characters.
    const l = layout(makeModel([{ text: "a😄b" }]));
    expect(l.paragraphs[0].endIndex - l.paragraphs[0].startIndex).toBe(5);
  });
});

describe("paragraphAt", () => {
  const l = layout(makeModel([{ text: "Hello" }, { text: "World" }]));

  it("finds the paragraph at its first index", () => {
    expect(paragraphAt(l, l.paragraphs[1].startIndex)?.paraIndex).toBe(1);
  });

  it("finds the paragraph at its last index", () => {
    expect(paragraphAt(l, l.paragraphs[0].endIndex - 1)?.paraIndex).toBe(0);
  });

  it("returns null past the end", () => {
    expect(paragraphAt(l, l.endIndex)).toBeNull();
  });
});

describe("normalise", () => {
  it("merges adjacent runs with identical styling", () => {
    const model = makeModel([{ runs: [{ content: "aa" }, { content: "bb" }] }]);
    normalise(model);
    expect(model.paragraphs[0].runs).toHaveLength(1);
    expect(model.paragraphs[0].runs[0].content).toBe("aabb\n");
  });

  it("keeps two runs when the styles differ", () => {
    const model = makeModel([{ runs: [{ content: "aa" }, { content: "bb", bold: true }] }]);
    normalise(model);
    expect(model.paragraphs[0].runs).toHaveLength(2);
  });

  it("drops empty runs but never leaves a paragraph with none", () => {
    const model = makeModel([{ text: "" }]);
    model.paragraphs[0].runs = [{ content: "", style: null }, { content: "", style: null }];
    normalise(model);
    expect(model.paragraphs[0].runs).toHaveLength(1);
    expect(model.paragraphs[0].runs[0].content).toBe("\n");
  });

  it("gives every paragraph exactly one trailing newline and no interior one", () => {
    const model = makeModel([{ text: "x" }]);
    model.paragraphs[0].runs = [{ content: "a\nb", style: null }];
    normalise(model);
    expect(model.paragraphs[0].runs.map((r) => r.content).join("")).toBe("ab\n");
  });

  it("restores a document with no paragraphs to the blank shape", () => {
    const model = makeModel([{ text: "x" }]);
    model.paragraphs = [];
    normalise(model);
    expect(layout(model).endIndex).toBe(2);
  });
});

describe("canonicalStyleJson", () => {
  it("is null for an absent or empty style, so both mean unstyled", () => {
    expect(canonicalStyleJson(null)).toBeNull();
    expect(canonicalStyleJson({})).toBeNull();
  });

  it("sorts keys at every depth, so key order cannot split a run", () => {
    const a = canonicalStyleJson({ bold: true, link: { url: "u", title: "t" } });
    const b = canonicalStyleJson({ link: { title: "t", url: "u" }, bold: true });
    expect(a).toBe(b);
    // Nested keys survive: JSON.stringify's replacer-array form would drop them.
    expect(a).toContain("url");
  });
});

describe("shiftNamedRanges", () => {
  it("moves a range that starts at or after the insertion", () => {
    const model = withRanges(makeModel([{ text: "abcdef" }]), [[4, 6]]);
    shiftNamedRanges(model, 2, 3);
    expect(model.namedRanges[0]).toMatchObject({ startIndex: 7, endIndex: 9 });
  });

  it("grows a range that straddles the insertion", () => {
    const model = withRanges(makeModel([{ text: "abcdef" }]), [[1, 6]]);
    shiftNamedRanges(model, 3, 2);
    expect(model.namedRanges[0]).toMatchObject({ startIndex: 1, endIndex: 8 });
  });

  it("leaves a range entirely before the insertion alone", () => {
    const model = withRanges(makeModel([{ text: "abcdef" }]), [[1, 3]]);
    shiftNamedRanges(model, 3, 5);
    expect(model.namedRanges[0]).toMatchObject({ startIndex: 1, endIndex: 3 });
  });

  it("truncates a range whose tail is deleted", () => {
    const model = withRanges(makeModel([{ text: "abcdefghij" }]), [[5, 20]]);
    shiftNamedRanges(model, 10, -5);
    expect(model.namedRanges[0]).toMatchObject({ startIndex: 5, endIndex: 15 });
  });

  it("truncates a range whose head is deleted", () => {
    const model = withRanges(makeModel([{ text: "abcdefghij" }]), [[12, 20]]);
    shiftNamedRanges(model, 10, -5);
    expect(model.namedRanges[0]).toMatchObject({ startIndex: 10, endIndex: 15 });
  });

  it("removes a range whose content is wholly deleted", () => {
    const model = withRanges(makeModel([{ text: "abcdefghij" }]), [[11, 14]]);
    shiftNamedRanges(model, 10, -5);
    expect(model.namedRanges).toHaveLength(0);
  });

  it("shifts a range that sits entirely after the deleted span", () => {
    const model = withRanges(makeModel([{ text: "abcdefghij" }]), [[20, 25]]);
    shiftNamedRanges(model, 10, -5);
    expect(model.namedRanges[0]).toMatchObject({ startIndex: 15, endIndex: 20 });
  });
});
