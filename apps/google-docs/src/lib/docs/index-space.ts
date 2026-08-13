import type { DocModel, NamedRangeModel, ParagraphModel, RunModel } from "./shape";

// The flat index space — the characteristic part of the Docs API, in one pure
// module. Nothing here touches the database or the clock.
//
// Every element in a document carries startIndex/endIndex in ONE space shared by
// the whole body, and batchUpdate operates on those numbers. Getting this wrong
// is the difference between a useful clone and a text blob with a REST wrapper,
// because an agent that reads a heading's endIndex and inserts there is relying
// on arithmetic it cannot check.
//
// The four invariants, which every function below either assumes or restores:
//
//   1. Index 0..1 is the body's leading section break. It occupies exactly one
//      index and is never stored — every document has exactly one.
//   2. Paragraph 0 starts at 1; paragraph k starts at paragraph k−1's endIndex.
//   3. A paragraph's text is the concatenation of its runs and ALWAYS ends with
//      exactly one "\n", counted in its endIndex. That is why a document is
//      never empty: a blank one is [0,1) section break plus [1,2) holding "\n".
//   4. Lengths are measured in UTF-16 code units, which is exactly what
//      JavaScript's String.prototype.length counts — so an emoji costs two
//      indexes, not one. This is the single place a naive implementation
//      silently diverges from the real API, and the seed contains an emoji so
//      the rule is exercised outside the tests too. The corollary is that the
//      index between an emoji's two halves is nameable but unusable, and
//      edit.ts guards it: half a surrogate pair is not a character.

export interface RunSpan {
  runIndex: number;
  startIndex: number;
  endIndex: number;
  content: string;
}

export interface ParagraphSpan {
  paraIndex: number;
  startIndex: number;
  endIndex: number;
  text: string;
  runs: RunSpan[];
}

export interface Layout {
  /** Always 1: the section break occupies [0, 1). */
  sectionBreakEndIndex: 1;
  paragraphs: ParagraphSpan[];
  /** One past the last index in the body — i.e. 1 + the body text's length. */
  endIndex: number;
}

/** Assign every paragraph and run its span in the one document-wide space. */
export function layout(model: DocModel): Layout {
  let cursor = 1;
  const paragraphs: ParagraphSpan[] = model.paragraphs.map((p, paraIndex) => {
    const startIndex = cursor;
    const runs = p.runs.map((run, runIndex) => {
      const span: RunSpan = {
        runIndex,
        startIndex: cursor,
        endIndex: cursor + run.content.length,
        content: run.content,
      };
      cursor = span.endIndex;
      return span;
    });
    return {
      paraIndex,
      startIndex,
      endIndex: cursor,
      text: runs.map((r) => r.content).join(""),
      runs,
    };
  });
  return { sectionBreakEndIndex: 1, paragraphs, endIndex: cursor };
}

/** The paragraph whose [startIndex, endIndex) contains `index`, or null. */
export function paragraphAt(l: Layout, index: number): ParagraphSpan | null {
  return l.paragraphs.find((p) => index >= p.startIndex && index < p.endIndex) ?? null;
}

/** The run within `p` whose [startIndex, endIndex) contains `index`, or null. */
export function runAt(p: ParagraphSpan, index: number): RunSpan | null {
  return p.runs.find((r) => index >= r.startIndex && index < r.endIndex) ?? null;
}

// ---------------------------------------------------------------------------
// Run surgery. Editing works on one cell per UTF-16 code unit and rebuilds runs
// afterwards, which is what keeps split-a-run, merge-two-runs and shift-every-
// index from being three separate pieces of arithmetic that drift apart.
// ---------------------------------------------------------------------------

export interface CharCell {
  ch: string;
  style: Record<string, unknown> | null;
}

/** One cell per code unit, each carrying the style of the run it came from. */
export function explodeParagraph(p: ParagraphModel): CharCell[] {
  const cells: CharCell[] = [];
  for (const run of p.runs) {
    for (let i = 0; i < run.content.length; i++) cells.push({ ch: run.content[i], style: run.style });
  }
  return cells;
}

/** Cells back to runs, one run per maximal stretch of identical styling. */
export function implodeRuns(cells: CharCell[]): RunModel[] {
  const runs: RunModel[] = [];
  let key: string | null | undefined;
  for (const cell of cells) {
    const cellKey = canonicalStyleJson(cell.style);
    if (runs.length && cellKey === key) {
      runs[runs.length - 1].content += cell.ch;
      continue;
    }
    runs.push({ content: cell.ch, style: cell.style });
    key = cellKey;
  }
  return runs;
}

/**
 * A stable string for a TextStyle, so two runs can be compared for "same
 * styling" by string equality — which is what stops the sandbox returning two
 * adjacent runs with identical styles, something the real API never does. Keys
 * are sorted at every depth (`JSON.stringify`'s replacer-array form cannot be
 * used: it filters nested objects by the same key list and would silently drop
 * `link.url`). An empty or absent style is null, i.e. the same as no style.
 */
export function canonicalStyleJson(style: Record<string, unknown> | null): string | null {
  if (!style || Object.keys(style).length === 0) return null;
  return JSON.stringify(sortKeysDeep(style));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(source).sort()) out[k] = sortKeysDeep(source[k]);
    return out;
  }
  return value;
}

/** The empty document every read and every edit falls back to. */
export function blankParagraph(): ParagraphModel {
  return {
    namedStyleType: "NORMAL_TEXT",
    headingId: null,
    alignment: null,
    runs: [{ content: "\n", style: null }],
  };
}

/**
 * Restore the invariants in place after an edit: at least one paragraph, at
 * least one run per paragraph, no interior "\n" anywhere, exactly one trailing
 * "\n" on the last run, and no two adjacent runs with the same styling. Every
 * edit that changes text calls this last, and it is idempotent.
 */
export function normalise(model: DocModel): void {
  if (!model.paragraphs.length) model.paragraphs.push(blankParagraph());
  for (const p of model.paragraphs) {
    // Interior newlines are dropped rather than split on: splitting a paragraph
    // is a decision about paragraph style and heading ids that only the edit
    // functions can make, so by the time normalise runs there must be none left.
    const cells = explodeParagraph(p).filter((c) => c.ch !== "\n");
    const tailStyle = cells.length ? cells[cells.length - 1].style : (p.runs[0]?.style ?? null);
    cells.push({ ch: "\n", style: tailStyle });
    p.runs = implodeRuns(cells);
  }
}

/**
 * Move every named range across an edit at `atIndex`. A bookmark that stops
 * pointing at its text is worse than no bookmark, so this runs on every insert
 * and every delete — and, like the vendor, a range whose content is entirely
 * deleted is removed rather than left collapsed on an arbitrary character.
 *
 * `delta > 0` is an insertion of that many code units at `atIndex`; `delta < 0`
 * is the deletion of the span [atIndex, atIndex − delta).
 */
export function shiftNamedRanges(model: DocModel, atIndex: number, delta: number): void {
  if (delta === 0) return;
  if (delta > 0) {
    for (const r of model.namedRanges) {
      if (r.startIndex >= atIndex) {
        r.startIndex += delta;
        r.endIndex += delta;
      } else if (r.endIndex > atIndex) {
        // Straddles the insertion point, so it grows to keep covering its text.
        r.endIndex += delta;
      }
    }
    return;
  }

  const length = -delta;
  const spanEnd = atIndex + length;
  const survivors: NamedRangeModel[] = [];
  for (const r of model.namedRanges) {
    if (r.endIndex <= atIndex) {
      survivors.push(r);
    } else if (r.startIndex >= spanEnd) {
      r.startIndex -= length;
      r.endIndex -= length;
      survivors.push(r);
    } else {
      const startIndex = Math.min(r.startIndex, atIndex);
      const endIndex = r.endIndex > spanEnd ? r.endIndex - length : atIndex;
      if (endIndex <= startIndex) continue; // wholly deleted
      r.startIndex = startIndex;
      r.endIndex = endIndex;
      survivors.push(r);
    }
  }
  model.namedRanges = survivors;
}
