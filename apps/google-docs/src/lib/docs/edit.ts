import { ALIGNMENTS, HEADING_STYLE_TYPES, NAMED_STYLE_TYPES } from "./defaults";
import { badRequestError } from "./errors";
import { newHeadingId, newNamedRangeId } from "./ids";
import {
  type CharCell,
  explodeParagraph,
  implodeRuns,
  layout,
  normalise,
  paragraphAt,
  runAt,
  shiftNamedRanges,
} from "./index-space";
import { plainText, type DocModel, type ParagraphModel } from "./shape";

// The five supported mutations, as pure functions over a DocModel. Nothing here
// reads the database or the clock: batch.ts sequences them and
// store/documents.ts persists the result, which is what lets the whole write
// surface be tested without a server.
//
// Every failure throws with the vendor's `Invalid requests[N].<field>: <reason>`
// prefix — the caller passes N in, because a batch reports which request failed
// and an agent retrying one of five needs to know which.
//
// Only two functions here touch text directly — insertText and
// deleteContentRange — and both end in normalise + shiftNamedRanges.
// replaceAllText changes text through those two rather than a third time itself.
// updateParagraphStyle and createNamedRange call neither, because a shift of zero
// and a normalise of untouched runs are both no-ops, and a call that can never do
// anything reads to the next person as a rule that exists.

/** A location or range this sandbox will act on. */
interface WireLocation {
  segmentId?: unknown;
  index?: unknown;
}

interface WireRange {
  segmentId?: unknown;
  startIndex?: unknown;
  endIndex?: unknown;
}

const SEGMENT_ONLY_BODY = "this sandbox models the document body only; segmentId must be empty.";

function invalid(n: number, field: string, reason: string): Error {
  return badRequestError(`Invalid requests[${n}].${field}: ${reason}`);
}

function requireBodySegment(n: number, field: string, ...locations: unknown[]): void {
  for (const location of locations) {
    if (!location || typeof location !== "object") continue;
    const segmentId = (location as WireLocation).segmentId;
    if (typeof segmentId === "string" && segmentId !== "") {
      throw invalid(n, field, SEGMENT_ONLY_BODY);
    }
  }
}

/** Proto3 reads an absent int32 as 0, and so does the real API. */
function intOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/**
 * Whether a oneof member was set. JSON `null` is how proto3 spells "leave this
 * message field unset", so it has to read as absent — otherwise `{"location":
 * null, "endOfSegmentLocation":{}}`, which the real parser accepts, would be
 * refused here as setting two members of a union.
 */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * Half a surrogate pair, on either side. It is not a character: SQLite stores
 * text as UTF-8, so a lone surrogate that reaches a column comes back to the
 * agent as U+FFFD — the same silent corruption the index-space guards below
 * refuse, arriving inside the payload instead of at its edges. V8's JSON.parse
 * accepts an unpaired surrogate in a body, so nothing upstream catches it.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The vendor filters exactly these code points on insert — the C0 controls other
 * than tab and newline, plus the private use area. A clone that stores them
 * produces documents whose indexes disagree with the real API's, which is the
 * worst kind of divergence: invisible until an agent's arithmetic is off by one.
 */
export function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000C-\u001F\uE000-\uF8FF]/g, "");
}

/**
 * Whether `index` names the boundary BETWEEN the two halves of a surrogate pair.
 *
 * Invariant 4 counts UTF-16 code units, so an emoji occupies two indexes and the
 * one between them is a number an agent can send — but no edit may act on it.
 * Half a pair is not a character: it reads back as U+FFFD, so an edit landing
 * there destroys the emoji and answers 200 to say it went well. Every other
 * bound in this file is arithmetic that this boundary passes cleanly, which
 * makes it the one unguarded edge of the invariant this clone advertises
 * hardest — and the vendor guards it, refusing the delete and quietly moving the
 * insert.
 *
 * `text` is the body text, in which document index i is text[i - 1]. charCodeAt
 * off either end returns NaN and every comparison against NaN is false, so the
 * document's two ends answer no without a bounds check of their own.
 */
function splitsSurrogatePair(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 2);
  const at = text.charCodeAt(index - 1);
  return before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
}

// ---------------------------------------------------------------------------
// insertText
// ---------------------------------------------------------------------------

export interface InsertTextRequest {
  text?: unknown;
  location?: WireLocation;
  endOfSegmentLocation?: WireLocation;
}

export function insertText(model: DocModel, n: number, req: InsertTextRequest): void {
  requireBodySegment(n, "insertText", req.location, req.endOfSegmentLocation);

  // `location` and `endOfSegmentLocation` are the two members of the
  // insertion_location oneof, which is to say two spellings of one field: the
  // real parser refuses a body that sets both and a body that sets neither.
  // Preferring one of the two silently would answer 200 to a request that asked
  // for an insert in two places, and reading an absent location as index 0 would
  // report a bounds problem for what is really a missing field. Same rule
  // batch.ts states one level up for the Request union, same words.
  const atLocation = isSet(req.location);
  const atEndOfSegment = isSet(req.endOfSegmentLocation);
  if (atLocation && atEndOfSegment) {
    throw invalid(n, "insertText", "exactly one insertion location field may be set.");
  }
  if (!atLocation && !atEndOfSegment) {
    throw invalid(n, "insertText", "an insertion location field must be set.");
  }

  const raw = typeof req.text === "string" ? req.text : "";
  const text = stripControlChars(raw);
  if (!text) throw invalid(n, "insertText", "The text to insert cannot be empty.");
  if (LONE_SURROGATE.test(text)) {
    throw invalid(n, "insertText", "The text to insert cannot contain an unpaired surrogate.");
  }

  const l = layout(model);
  // endOfSegmentLocation lands immediately BEFORE the body's final newline —
  // exactly what the vendor does, and the reason appending a paragraph works.
  const requested = atEndOfSegment ? l.endIndex - 1 : intOf(req.location?.index);
  if (requested < 1 || requested > l.endIndex - 1) {
    throw invalid(
      n,
      "insertText",
      "The insertion index must be inside the bounds of an existing paragraph.",
    );
  }

  // The vendor documents that it may implicitly adjust the location to keep an
  // insertion out of the middle of a grapheme cluster, and a surrogate pair is
  // the case that matters here — so an index between two halves moves forward
  // past the low surrogate rather than becoming a 400. The nudge can never cross
  // the bound checked above: the last legal index sits before the body's final
  // "\n", and a newline is not a low surrogate.
  const index = splitsSurrogatePair(plainText(model), requested) ? requested + 1 : requested;

  // Bounds were just checked and the paragraphs tile [1, endIndex), so this
  // lookup cannot miss; the assertion is for the type checker, not the reader.
  const span = paragraphAt(l, index)!;
  const para = model.paragraphs[span.paraIndex];
  const offset = index - span.startIndex;

  // The vendor gives inserted text the styling of the character before it, which
  // is why typing at the end of a bolded sentence stays bold. At a paragraph
  // start there is no preceding character in this paragraph, so the first run's
  // style is the only sensible answer.
  const before = offset > 0 ? runAt(span, index - 1) : null;
  const inherited = before ? para.runs[before.runIndex].style : (para.runs[0]?.style ?? null);

  const cells = explodeParagraph(para);
  const inserted: CharCell[] = [];
  for (let i = 0; i < text.length; i++) inserted.push({ ch: text[i], style: inherited });
  const merged = [...cells.slice(0, offset), ...inserted, ...cells.slice(offset)];

  model.paragraphs.splice(span.paraIndex, 1, ...splitCells(merged, para));
  normalise(model);
  shiftNamedRanges(model, index, text.length);
}

/**
 * Cells containing newlines become several paragraphs, each keeping its own
 * terminating "\n". They all inherit `from`'s style, and a split of a heading is
 * therefore several headings — each of which needs an anchor id of its own. The
 * first keeps `from`'s, because a link already pointing at that heading has to
 * keep resolving; the rest are minted, never copied, because one id naming two
 * anchors is the same outline corruption from the other direction.
 */
function splitCells(cells: CharCell[], from: ParagraphModel): ParagraphModel[] {
  const paragraphs: ParagraphModel[] = [];
  let current: CharCell[] = [];
  for (const cell of cells) {
    current.push(cell);
    if (cell.ch === "\n") {
      paragraphs.push(paragraphFrom(current, from, paragraphs.length === 0));
      current = [];
    }
  }
  // A trailing stretch with no newline can only come from a paragraph that
  // already broke invariant 3. It becomes its own paragraph and normalise gives
  // it the newline it is missing, rather than being silently dropped.
  if (current.length) paragraphs.push(paragraphFrom(current, from, paragraphs.length === 0));
  return paragraphs;
}

function paragraphFrom(cells: CharCell[], from: ParagraphModel, first: boolean): ParagraphModel {
  // Nulling the continuations instead would answer HEADING_1 with no headingId,
  // which the vendor's own field doc calls a contradiction — an empty headingId
  // means the paragraph is not a heading. It also splits the judge from the
  // agent: the twin snapshot counts headings by namedStyleType and would list a
  // heading the agent, reading paragraphStyle.headingId, cannot see.
  const headingId = first
    ? from.headingId
    : HEADING_STYLE_TYPES.includes(from.namedStyleType)
      ? newHeadingId()
      : null;
  return {
    namedStyleType: from.namedStyleType,
    headingId,
    alignment: from.alignment,
    runs: implodeRuns(cells),
  };
}

// ---------------------------------------------------------------------------
// deleteContentRange
// ---------------------------------------------------------------------------

export interface DeleteContentRangeRequest {
  range?: WireRange;
}

export function deleteContentRange(
  model: DocModel,
  n: number,
  req: DeleteContentRangeRequest,
): void {
  requireBodySegment(n, "deleteContentRange", req.range);
  const startIndex = intOf(req.range?.startIndex);
  const endIndex = intOf(req.range?.endIndex);

  if (startIndex < 1) {
    throw invalid(
      n,
      "deleteContentRange",
      "The range cannot include the section break at the start of the body.",
    );
  }
  if (endIndex <= startIndex) throw invalid(n, "deleteContentRange", "The range must not be empty.");

  const l = layout(model);
  // One check covers both "past the end" and "eats the final newline": the
  // largest legal endIndex is l.endIndex - 1, because a body always ends in a
  // newline and the API refuses to delete it.
  if (endIndex > l.endIndex - 1) {
    throw invalid(
      n,
      "deleteContentRange",
      "The last newline character of the body cannot be deleted.",
    );
  }
  // Both ends, because either one alone leaves the other half of the pair
  // stranded. The vendor lists deleting one code unit of a surrogate pair among
  // the requests it rejects outright, and it is right to: there is no way to
  // honour such a range that does not corrupt a character the agent can see.
  const body = plainText(model);
  for (const boundary of [startIndex, endIndex]) {
    if (splitsSurrogatePair(body, boundary)) {
      throw invalid(n, "deleteContentRange", "The range cannot split a surrogate pair.");
    }
  }

  // Body cells are the whole document laid flat; body cell j sits at index 1 + j.
  const cells: Array<CharCell & { paraIndex: number }> = [];
  model.paragraphs.forEach((p, paraIndex) => {
    for (const cell of explodeParagraph(p)) cells.push({ ...cell, paraIndex });
  });
  const kept = [...cells.slice(0, startIndex - 1), ...cells.slice(endIndex - 1)];

  // Re-split on "\n". Each surviving paragraph takes the style of the FIRST
  // original paragraph contributing a character to it — which is what the editor
  // does when you backspace at the start of a paragraph: the two merge and the
  // earlier one's style wins.
  const paragraphs: ParagraphModel[] = [];
  let current: Array<CharCell & { paraIndex: number }> = [];
  const flush = (): void => {
    const source = model.paragraphs[current[0].paraIndex];
    paragraphs.push(paragraphFrom(current, source, true));
    current = [];
  };
  for (const cell of kept) {
    current.push(cell);
    if (cell.ch === "\n") flush();
  }
  // Same tail case as splitCells: only reachable from a document that arrived
  // without its final newline, and normalise repairs it rather than losing it.
  if (current.length) flush();

  model.paragraphs = paragraphs;
  normalise(model);
  shiftNamedRanges(model, startIndex, -(endIndex - startIndex));
}

// ---------------------------------------------------------------------------
// replaceAllText
// ---------------------------------------------------------------------------

export interface ReplaceAllTextRequest {
  containsText?: { text?: unknown; matchCase?: unknown };
  replaceText?: unknown;
}

export function replaceAllText(model: DocModel, n: number, req: ReplaceAllTextRequest): number {
  const needle = typeof req.containsText?.text === "string" ? req.containsText.text : "";
  if (!needle) throw invalid(n, "replaceAllText", "The text to find cannot be empty.");
  const matchCase = req.containsText?.matchCase === true;
  const replaceText = typeof req.replaceText === "string" ? req.replaceText : "";
  // Checked here rather than left to the insertText this delegates to, for the
  // same reason a needle is never allowed to match half a pair: the agent sent
  // replaceAllText, and a 400 naming a request it never sent sends it looking
  // for a bug in the wrong place. The needle itself is not checked — a lone
  // surrogate there simply matches nothing, which is answered below.
  if (LONE_SURROGATE.test(replaceText)) {
    throw invalid(
      n,
      "replaceAllText",
      "The replacement text cannot contain an unpaired surrogate.",
    );
  }

  // Each paragraph is searched EXCLUDING its trailing "\n", so a match can never
  // span a paragraph boundary or eat a newline — which would silently merge two
  // paragraphs on what looked like a text substitution.
  const body = plainText(model);
  const starts: number[] = [];
  for (const span of layout(model).paragraphs) {
    const hay = span.text.slice(0, -1);
    for (let i = 0; i + needle.length <= hay.length; ) {
      // A needle carrying a lone surrogate can line up with half of a pair. That
      // is not a match — it is an offer to destroy a character — and taking it
      // would surface as a 400 naming deleteContentRange, a request the agent
      // never sent.
      const at = span.startIndex + i;
      if (
        matchesAt(hay, i, needle, matchCase) &&
        !splitsSurrogatePair(body, at) &&
        !splitsSurrogatePair(body, at + needle.length)
      ) {
        starts.push(at);
        i += needle.length;
      } else {
        i++;
      }
    }
  }

  // Applied right-to-left as delete-then-insert, which keeps every earlier index
  // valid and means run splitting and named-range shifting are implemented once
  // rather than a third time here.
  for (const start of starts.reverse()) {
    deleteContentRange(model, n, { range: { startIndex: start, endIndex: start + needle.length } });
    if (replaceText) insertText(model, n, { text: replaceText, location: { index: start } });
  }
  return starts.length;
}

/**
 * Compared code unit by code unit rather than by lowercasing both sides: some
 * characters change length under toLowerCase ('İ' becomes two code units), and a
 * length change here would corrupt every index after the match.
 */
function matchesAt(hay: string, at: number, needle: string, matchCase: boolean): boolean {
  for (let k = 0; k < needle.length; k++) {
    const a = hay[at + k];
    const b = needle[k];
    if (a === b) continue;
    if (matchCase || a.toLowerCase() !== b.toLowerCase()) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// updateParagraphStyle
// ---------------------------------------------------------------------------

export interface UpdateParagraphStyleRequest {
  range?: WireRange;
  paragraphStyle?: { namedStyleType?: unknown; alignment?: unknown };
  fields?: unknown;
}

const SUPPORTED_FIELDS = ["namedStyleType", "alignment"];

export function updateParagraphStyle(
  model: DocModel,
  n: number,
  req: UpdateParagraphStyleRequest,
): void {
  requireBodySegment(n, "updateParagraphStyle", req.range);

  const fields = typeof req.fields === "string" ? req.fields : "";
  const mask = fields
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (!mask.length) throw invalid(n, "updateParagraphStyle", "The field mask is required.");
  for (const field of mask) {
    if (field !== "*" && !SUPPORTED_FIELDS.includes(field)) {
      throw invalid(
        n,
        "updateParagraphStyle",
        `this sandbox supports only the namedStyleType and alignment fields; got "${field}".`,
      );
    }
  }
  const all = mask.includes("*");
  const wants = (field: string): boolean => all || mask.includes(field);

  const l = layout(model);
  const startIndex = intOf(req.range?.startIndex);
  const endIndex = intOf(req.range?.endIndex);
  if (startIndex < 1 || endIndex > l.endIndex || endIndex < startIndex) {
    throw invalid(
      n,
      "updateParagraphStyle",
      `The range must lie within [1, ${l.endIndex}] and must not be inverted.`,
    );
  }

  // A collapsed range styles the paragraph holding the index — that is how an
  // agent promotes the line it just wrote without measuring its length.
  const targets = l.paragraphs.filter((p) =>
    endIndex === startIndex
      ? startIndex >= p.startIndex && startIndex < p.endIndex
      : p.startIndex < endIndex && p.endIndex > startIndex,
  );
  // The paragraphs tile [1, endIndex), so a collapsed range at exactly
  // l.endIndex clears the bounds check above and still names no paragraph.
  // Applying nothing and answering 200 with a fresh revisionId is the one
  // failure an agent cannot see: it looks exactly like the promotion it asked
  // for. Pointing at the end of the document is what an agent does when it means
  // "the line I just appended", so this is a mistake worth naming.
  if (!targets.length) {
    throw invalid(n, "updateParagraphStyle", "The range must overlap at least one paragraph.");
  }

  let namedStyleType: string | null = null;
  if (wants("namedStyleType")) {
    const value = req.paragraphStyle?.namedStyleType;
    if (value === undefined && all) {
      namedStyleType = "NORMAL_TEXT";
    } else if (typeof value === "string" && (NAMED_STYLE_TYPES as readonly string[]).includes(value)) {
      namedStyleType = value;
    } else {
      throw invalid(
        n,
        "updateParagraphStyle",
        `namedStyleType must be one of ${NAMED_STYLE_TYPES.join(", ")}; got ${JSON.stringify(value)}.`,
      );
    }
  }

  let alignment: string | null = null;
  if (wants("alignment")) {
    const value = req.paragraphStyle?.alignment;
    if (value === undefined || value === null) {
      alignment = null;
    } else if (typeof value === "string" && (ALIGNMENTS as readonly string[]).includes(value)) {
      alignment = value;
    } else {
      throw invalid(
        n,
        "updateParagraphStyle",
        `alignment must be one of ${ALIGNMENTS.join(", ")}; got ${JSON.stringify(value)}.`,
      );
    }
  }

  for (const span of targets) {
    const para = model.paragraphs[span.paraIndex];
    if (namedStyleType !== null) {
      para.namedStyleType = namedStyleType;
      // A heading needs an anchor id and body text must not keep one, or the
      // document's outline would list a paragraph that is no longer a heading.
      if (HEADING_STYLE_TYPES.includes(namedStyleType)) {
        para.headingId ??= newHeadingId();
      } else {
        para.headingId = null;
      }
    }
    if (wants("alignment")) para.alignment = alignment;
  }
}

// ---------------------------------------------------------------------------
// createNamedRange
// ---------------------------------------------------------------------------

export interface CreateNamedRangeRequest {
  name?: unknown;
  range?: WireRange;
}

export function createNamedRange(
  model: DocModel,
  n: number,
  req: CreateNamedRangeRequest,
): string {
  requireBodySegment(n, "createNamedRange", req.range);
  const name = typeof req.name === "string" ? req.name : "";
  if (!name) throw invalid(n, "createNamedRange", "The name cannot be empty.");
  if (name.length > 256) {
    throw invalid(n, "createNamedRange", "The name must be at most 256 characters.");
  }

  const l = layout(model);
  const startIndex = intOf(req.range?.startIndex);
  const endIndex = intOf(req.range?.endIndex);
  if (startIndex < 1 || endIndex > l.endIndex) {
    throw invalid(n, "createNamedRange", `The range must lie within [1, ${l.endIndex}].`);
  }
  if (endIndex <= startIndex) throw invalid(n, "createNamedRange", "The range must not be empty.");

  const id = newNamedRangeId();
  model.namedRanges.push({ id, name, startIndex, endIndex });
  return id;
}
