import { describe, expect, it } from "vitest";
import { NAMED_STYLE_TYPES, SECTION_BREAK_STYLE } from "@/lib/docs/defaults";
import { plainText, shapeDocument } from "@/lib/docs/shape";
import { makeModel } from "./helpers";

// Resource fidelity — what the SDK actually sees. Every assertion here is a claim
// about the real API's JSON, not about this implementation's convenience.

interface Element {
  startIndex?: number;
  endIndex: number;
  sectionBreak?: unknown;
  paragraph?: {
    elements: Array<{
      startIndex: number;
      endIndex: number;
      textRun: { content: string; textStyle: Record<string, unknown> };
    }>;
    paragraphStyle: Record<string, unknown>;
  };
}

function content(doc: Record<string, unknown>): Element[] {
  return (doc.body as { content: Element[] }).content;
}

describe("shapeDocument", () => {
  it("emits Google's exact JSON for a blank document's body", () => {
    const doc = shapeDocument(makeModel([{ text: "" }]), {});
    expect(content(doc)).toEqual([
      { endIndex: 1, sectionBreak: { sectionStyle: SECTION_BREAK_STYLE } },
      {
        startIndex: 1,
        endIndex: 2,
        paragraph: {
          elements: [
            { startIndex: 1, endIndex: 2, textRun: { content: "\n", textStyle: {} } },
          ],
          paragraphStyle: { namedStyleType: "NORMAL_TEXT", direction: "LEFT_TO_RIGHT" },
        },
      },
    ]);
  });

  it("omits startIndex on the section break rather than emitting a zero", () => {
    // proto3 JSON drops zero values, so emitting `startIndex: 0` is a tell.
    expect("startIndex" in content(shapeDocument(makeModel([{ text: "x" }]), {}))[0]).toBe(false);
  });

  it("carries both indexes on every other element and every paragraph element", () => {
    const doc = shapeDocument(makeModel([{ text: "one" }, { text: "two" }]), {});
    for (const element of content(doc).slice(1)) {
      expect(typeof element.startIndex).toBe("number");
      expect(typeof element.endIndex).toBe("number");
      for (const el of element.paragraph!.elements) {
        expect(typeof el.startIndex).toBe("number");
        expect(typeof el.endIndex).toBe("number");
      }
    }
  });

  it("always emits textStyle: {} for an unstyled run and {bold:true} for a bold one", () => {
    const doc = shapeDocument(
      makeModel([{ runs: [{ content: "plain" }, { content: "loud", bold: true }] }]),
      {},
    );
    const elements = content(doc)[1].paragraph!.elements;
    expect(elements[0].textRun.textStyle).toEqual({});
    expect(elements[1].textRun.textStyle).toEqual({ bold: true });
  });

  it("puts headingId on a heading paragraph and neither headingId nor alignment on body text", () => {
    const doc = shapeDocument(makeModel([{ style: "HEADING_1", text: "H" }, { text: "b" }]), {});
    const heading = content(doc)[1].paragraph!.paragraphStyle;
    expect(heading.namedStyleType).toBe("HEADING_1");
    expect(typeof heading.headingId).toBe("string");
    const body = content(doc)[2].paragraph!.paragraphStyle;
    expect("headingId" in body).toBe(false);
    expect("alignment" in body).toBe(false);
  });

  it("omits the empty maps entirely instead of emitting {}", () => {
    const doc = shapeDocument(makeModel([{ text: "x" }]), {});
    for (const key of [
      "lists",
      "inlineObjects",
      "positionedObjects",
      "headers",
      "footers",
      "footnotes",
      "namedRanges",
    ]) {
      expect(key in doc).toBe(false);
    }
  });

  it("keys namedRanges by NAME and puts two ranges sharing one name in a single array", () => {
    const model = makeModel([{ text: "abcdefgh" }]);
    model.namedRanges = [
      { id: "kix.aaaaaaaaaaaa", name: "Evidence owners", startIndex: 1, endIndex: 3 },
      { id: "kix.bbbbbbbbbbbb", name: "Evidence owners", startIndex: 5, endIndex: 7 },
      { id: "kix.cccccccccccc", name: "Other", startIndex: 3, endIndex: 4 },
    ];
    const named = shapeDocument(model, {}).namedRanges as Record<
      string,
      { name: string; namedRanges: Array<{ namedRangeId: string; name: string; ranges: object[] }> }
    >;
    expect(Object.keys(named).sort()).toEqual(["Evidence owners", "Other"]);
    expect(named["Evidence owners"].namedRanges).toHaveLength(2);
    expect(named["Evidence owners"].namedRanges[0].namedRangeId).toBe("kix.aaaaaaaaaaaa");
    // A body range carries the two indexes and nothing else: `segmentId: ""` is
    // a proto3 zero value, and emitting it is the same tell as `startIndex: 0`
    // on the section break.
    expect(named["Evidence owners"].namedRanges[0].ranges[0]).toEqual({
      startIndex: 1,
      endIndex: 3,
    });
  });

  it("always carries documentStyle and one namedStyles entry per named style type", () => {
    const doc = shapeDocument(makeModel([{ text: "x" }]), {});
    expect(doc.documentStyle).toBeDefined();
    const styles = (doc.namedStyles as { styles: Array<{ namedStyleType: string }> }).styles;
    expect(styles.map((s) => s.namedStyleType)).toEqual([...NAMED_STYLE_TYPES]);
  });

  it("echoes suggestionsViewMode, defaulting to SUGGESTIONS_INLINE", () => {
    expect(shapeDocument(makeModel([{ text: "x" }]), {}).suggestionsViewMode).toBe(
      "SUGGESTIONS_INLINE",
    );
    expect(
      shapeDocument(makeModel([{ text: "x" }]), {
        suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS",
      }).suggestionsViewMode,
    ).toBe("PREVIEW_WITHOUT_SUGGESTIONS");
  });

  it("populates tabs INSTEAD of the top-level content fields, never both", () => {
    const model = makeModel([{ text: "x" }]);
    model.namedRanges = [{ id: "kix.aaaaaaaaaaaa", name: "Span", startIndex: 1, endIndex: 2 }];

    const doc = shapeDocument(model, { includeTabsContent: true });
    const tabs = doc.tabs as Array<{
      tabProperties: { tabId: string; title: string; index: number };
      documentTab: Record<string, unknown>;
    }>;
    expect(tabs[0].tabProperties.tabId).toBe("t.0");
    expect((tabs[0].documentTab.body as { content: Element[] }).content).toHaveLength(2);
    expect(tabs[0].documentTab.namedRanges).toBeDefined();
    // The flag is a switch, not an addition: upstream leaves body undefined under
    // it, so a clone that fills both teaches a fallback that reads undefined
    // against Google — and one that only ever reads doc.body here would break
    // the other way.
    for (const key of ["body", "documentStyle", "namedStyles", "namedRanges"]) {
      expect(key in doc).toBe(false);
    }
  });

  it("omits tabs entirely when they were not asked for", () => {
    const doc = shapeDocument(makeModel([{ text: "x" }]), {});
    expect("tabs" in doc).toBe(false);
    expect(doc.body).toBeDefined();
  });
});

describe("plainText", () => {
  it("concatenates every run in order, trailing newlines included", () => {
    const model = makeModel([{ runs: [{ content: "a" }, { content: "b", bold: true }] }, { text: "c" }]);
    expect(plainText(model)).toBe("ab\nc\n");
  });
});
