// The constant blobs a real Document always carries and this sandbox does not
// model. Page setup and the named-style table are constants, not state: nothing
// in the supported request set can change them, and omitting them would be the
// loudest tell in the response — a Document with no `documentStyle` is not a
// Document any agent has ever seen. Copied from a real blank document.

export const SECTION_BREAK_STYLE = {
  columnSeparatorStyle: "NONE",
  contentDirection: "LEFT_TO_RIGHT",
  sectionType: "CONTINUOUS",
} as const;

/** US Letter with 1in margins — the defaults Google gives a new document. */
export const DOCUMENT_STYLE = {
  background: { color: {} },
  pageNumberStart: 1,
  marginTop: { magnitude: 72, unit: "PT" },
  marginBottom: { magnitude: 72, unit: "PT" },
  marginRight: { magnitude: 72, unit: "PT" },
  marginLeft: { magnitude: 72, unit: "PT" },
  pageSize: {
    height: { magnitude: 792, unit: "PT" },
    width: { magnitude: 612, unit: "PT" },
  },
  marginHeader: { magnitude: 36, unit: "PT" },
  marginFooter: { magnitude: 36, unit: "PT" },
  useCustomHeaderFooterMargins: true,
} as const;

export const NAMED_STYLE_TYPES = [
  "NORMAL_TEXT",
  "TITLE",
  "SUBTITLE",
  "HEADING_1",
  "HEADING_2",
  "HEADING_3",
  "HEADING_4",
  "HEADING_5",
  "HEADING_6",
] as const;

/** Everything except body text — the set of styles that carries a headingId. */
export const HEADING_STYLE_TYPES: readonly string[] = NAMED_STYLE_TYPES.filter(
  (t) => t !== "NORMAL_TEXT",
);

export const ALIGNMENTS = ["START", "CENTER", "END", "JUSTIFIED"] as const;

/** The shared half of every named style's textStyle — only the size varies. */
function textStyle(
  fontSize: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    smallCaps: false,
    baselineOffset: "NONE",
    fontSize: { magnitude: fontSize, unit: "PT" },
    weightedFontFamily: { fontFamily: "Arial", weight: 400 },
    foregroundColor: { color: { rgbColor: {} } },
    backgroundColor: {},
    ...extra,
  };
}

const BASE_PARAGRAPH_STYLE = {
  alignment: "START",
  lineSpacing: 100,
  direction: "LEFT_TO_RIGHT",
  spacingMode: "COLLAPSE_LISTS",
  spaceAbove: { magnitude: 0, unit: "PT" },
  spaceBelow: { magnitude: 0, unit: "PT" },
  keepLinesTogether: false,
  keepWithNext: false,
  avoidWidowAndOrphan: true,
  shading: { backgroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } } },
  pageBreakBefore: false,
} as const;

function paragraphStyle(
  namedStyleType: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...BASE_PARAGRAPH_STYLE, namedStyleType, ...extra };
}

export const NAMED_STYLES = {
  styles: [
    {
      namedStyleType: "NORMAL_TEXT",
      textStyle: textStyle(11),
      paragraphStyle: paragraphStyle("NORMAL_TEXT"),
    },
    {
      namedStyleType: "TITLE",
      textStyle: textStyle(26),
      paragraphStyle: paragraphStyle("TITLE"),
    },
    {
      namedStyleType: "SUBTITLE",
      textStyle: textStyle(15, {
        italic: false,
        foregroundColor: {
          color: { rgbColor: { red: 0.4, green: 0.4, blue: 0.4 } },
        },
      }),
      paragraphStyle: paragraphStyle("SUBTITLE"),
    },
    {
      namedStyleType: "HEADING_1",
      textStyle: textStyle(20),
      paragraphStyle: paragraphStyle("HEADING_1", {
        spaceAbove: { magnitude: 20, unit: "PT" },
        spaceBelow: { magnitude: 6, unit: "PT" },
      }),
    },
    {
      namedStyleType: "HEADING_2",
      textStyle: textStyle(16),
      paragraphStyle: paragraphStyle("HEADING_2", {
        spaceAbove: { magnitude: 18, unit: "PT" },
        spaceBelow: { magnitude: 6, unit: "PT" },
      }),
    },
    {
      namedStyleType: "HEADING_3",
      textStyle: textStyle(14),
      paragraphStyle: paragraphStyle("HEADING_3", {
        spaceAbove: { magnitude: 16, unit: "PT" },
        spaceBelow: { magnitude: 4, unit: "PT" },
      }),
    },
    {
      namedStyleType: "HEADING_4",
      textStyle: textStyle(12),
      paragraphStyle: paragraphStyle("HEADING_4", {
        spaceAbove: { magnitude: 14, unit: "PT" },
        spaceBelow: { magnitude: 4, unit: "PT" },
      }),
    },
    {
      namedStyleType: "HEADING_5",
      textStyle: textStyle(11),
      paragraphStyle: paragraphStyle("HEADING_5", {
        spaceAbove: { magnitude: 12, unit: "PT" },
        spaceBelow: { magnitude: 4, unit: "PT" },
      }),
    },
    {
      namedStyleType: "HEADING_6",
      textStyle: textStyle(11, { italic: true }),
      paragraphStyle: paragraphStyle("HEADING_6", {
        spaceAbove: { magnitude: 12, unit: "PT" },
        spaceBelow: { magnitude: 4, unit: "PT" },
      }),
    },
  ],
} as const;
