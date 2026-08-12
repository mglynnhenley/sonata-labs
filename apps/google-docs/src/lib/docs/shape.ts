import { DOCUMENT_STYLE, NAMED_STYLES, SECTION_BREAK_STYLE } from "./defaults";
import { layout } from "./index-space";

// Rows -> a Google Docs v1 Document resource. The fidelity linchpin.
//
// Columns are the source of truth for everything batchUpdate can mutate —
// paragraph style, heading id, alignment, run content. raw_json/style_json carry
// only the fields the sandbox echoes but never reasons about. Every read
// rebuilds the resource from the columns and lays the passthrough underneath, so
// the official SDK cannot tell a seeded document from one an agent created.

// --- rows, exactly as SQLite returns them ------------------------------------

export interface DocumentRow {
  id: string;
  title: string;
  revision_id: string;
  owner_email: string | null;
  created_ms: number;
  updated_ms: number;
  is_sandbox_created: number;
}

export interface ParagraphRow {
  document_id: string;
  para_index: number;
  named_style_type: string;
  heading_id: string | null;
  alignment: string | null;
  raw_json: string | null;
}

export interface TextRunRow {
  document_id: string;
  para_index: number;
  run_index: number;
  content: string;
  style_json: string | null;
}

export interface NamedRangeRow {
  id: string;
  document_id: string;
  name: string;
  start_index: number;
  end_index: number;
}

// --- the in-memory model every read and every edit works on ------------------

export interface RunModel {
  content: string;
  style: Record<string, unknown> | null;
}

export interface ParagraphModel {
  namedStyleType: string;
  headingId: string | null;
  alignment: string | null;
  /** paragraphStyle fields echoed back verbatim — spaceAbove, indentStart, bullet. */
  extra: Record<string, unknown> | null;
  runs: RunModel[];
}

export interface NamedRangeModel {
  id: string;
  name: string;
  startIndex: number;
  endIndex: number;
}

export interface DocModel {
  documentId: string;
  title: string;
  revisionId: string;
  paragraphs: ParagraphModel[];
  namedRanges: NamedRangeModel[];
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** Group the three row sets into the model. Rows must arrive already ordered. */
export function toModel(
  doc: DocumentRow,
  paragraphs: ParagraphRow[],
  runs: TextRunRow[],
  ranges: NamedRangeRow[],
): DocModel {
  const byPara = new Map<number, RunModel[]>();
  for (const run of runs) {
    const list = byPara.get(run.para_index);
    const model: RunModel = { content: run.content, style: parseJson(run.style_json) };
    if (list) list.push(model);
    else byPara.set(run.para_index, [model]);
  }
  return {
    documentId: doc.id,
    title: doc.title,
    revisionId: doc.revision_id,
    paragraphs: paragraphs.map((p) => ({
      namedStyleType: p.named_style_type,
      headingId: p.heading_id,
      alignment: p.alignment,
      extra: parseJson(p.raw_json),
      runs: byPara.get(p.para_index) ?? [],
    })),
    namedRanges: ranges.map((r) => ({
      id: r.id,
      name: r.name,
      startIndex: r.start_index,
      endIndex: r.end_index,
    })),
  };
}

/** Every run's content in order — the body text, whose length is characterCount. */
export function plainText(model: DocModel): string {
  return model.paragraphs.map((p) => p.runs.map((r) => r.content).join("")).join("");
}

export interface ShapeOptions {
  suggestionsViewMode?: string;
  includeTabsContent?: boolean;
}

type Json = Record<string, unknown>;

function shapeBody(model: DocModel): Json {
  const l = layout(model);
  // `startIndex` is omitted on the leading section break, not set to 0: proto3
  // JSON drops zero values, and emitting it is a tell.
  const content: Json[] = [{ endIndex: 1, sectionBreak: { sectionStyle: SECTION_BREAK_STYLE } }];
  for (const span of l.paragraphs) {
    const p = model.paragraphs[span.paraIndex];
    const paragraphStyle: Json = {
      ...(p.extra ?? {}),
      namedStyleType: p.namedStyleType,
      direction: "LEFT_TO_RIGHT",
    };
    if (p.headingId !== null) paragraphStyle.headingId = p.headingId;
    if (p.alignment !== null) paragraphStyle.alignment = p.alignment;
    content.push({
      startIndex: span.startIndex,
      endIndex: span.endIndex,
      paragraph: {
        elements: span.runs.map((run) => ({
          startIndex: run.startIndex,
          endIndex: run.endIndex,
          textRun: {
            content: run.content,
            // textStyle is ALWAYS present, `{}` for an unstyled run — the vendor
            // never omits it, and an agent reading elements[0].textStyle.bold
            // would throw on a missing one.
            textStyle: p.runs[run.runIndex].style ?? {},
          },
        })),
        paragraphStyle,
      },
    });
  }
  return { content };
}

/** The namedRanges map, keyed by NAME — or undefined when there are none. */
function shapeNamedRanges(model: DocModel): Json | undefined {
  if (!model.namedRanges.length) return undefined;
  const byName: Json = {};
  for (const r of model.namedRanges) {
    const entry = (byName[r.name] ??= { name: r.name, namedRanges: [] }) as {
      name: string;
      namedRanges: Json[];
    };
    entry.namedRanges.push({
      namedRangeId: r.id,
      name: r.name,
      ranges: [{ startIndex: r.startIndex, endIndex: r.endIndex, segmentId: "" }],
    });
  }
  return byName;
}

/** The whole Document resource, as the SDK sees it. */
export function shapeDocument(model: DocModel, opts: ShapeOptions): Json {
  const namedRanges = shapeNamedRanges(model);
  const doc: Json = {
    documentId: model.documentId,
    title: model.title,
    revisionId: model.revisionId,
    suggestionsViewMode: opts.suggestionsViewMode ?? "SUGGESTIONS_INLINE",
  };

  // includeTabsContent is a switch between two views, not an addition to one:
  // the vendor populates the content in `tabs` INSTEAD of the top-level fields,
  // and leaves `body` undefined. Emitting both would be the most expensive kind
  // of divergence — code written here that falls back to `doc.body` reads
  // undefined against Google, and nothing in this sandbox would have said so.
  if (opts.includeTabsContent) {
    doc.tabs = [
      {
        tabProperties: { tabId: "t.0", title: "Tab 1", index: 0 },
        documentTab: {
          body: shapeBody(model),
          documentStyle: DOCUMENT_STYLE,
          namedStyles: NAMED_STYLES,
          ...(namedRanges ? { namedRanges } : {}),
        },
      },
    ];
    return doc;
  }

  // The other view: the first tab's content in the top-level fields, and no
  // `tabs` key at all. `lists`, `inlineObjects`, `positionedObjects`, `headers`,
  // `footers` and `footnotes` are omitted rather than emitted as `{}` — the
  // vendor omits empty maps, and an empty one would read as "this document has
  // that feature, and it is unused", which is a different claim.
  doc.body = shapeBody(model);
  doc.documentStyle = DOCUMENT_STYLE;
  doc.namedStyles = NAMED_STYLES;
  if (namedRanges) doc.namedRanges = namedRanges;
  return doc;
}
