// The Docs twin's half of the seed contract. The contract itself is written out
// in full at the top of packages/world/src/inject.ts; these are the shapes that
// arrive on the wire.
//
// Deliberately NOT typed against @sonata/core: a twin is a standalone app that
// must run (and be tested) with no orchestrator installed. Everything below is
// structurally compatible with the orchestrator's shapes, and that compatibility
// is the contract.

/** Structurally core's `Person`. Only the fields this twin actually reads. */
export interface WirePerson {
  id: string;
  name: string;
  email: string;
}

/** Structurally core's `WorldSeed`. The cast is what makes the clone coherent. */
export interface WireWorld {
  business: { name: string };
  cast: WirePerson[];
  mailboxOwner: string;
}

export interface DocsWireTextRun {
  content: string;
  bold?: boolean;
  italic?: boolean;
  link?: string;
}

/** A paragraph sets exactly one of `text` (unstyled) or `runs` (styled). */
export interface DocsWireParagraph {
  namedStyleType?: string;
  text?: string;
  runs?: DocsWireTextRun[];
}

export interface DocsWireDocument {
  id: string;
  title: string;
  ownerEmail: string;
  paragraphs: DocsWireParagraph[];
}

export interface DocsWireSeed {
  world: WireWorld;
  /** The instant every relative offset in the source seed was resolved against. */
  nowISO: string;
  /** Make the seeded state the one `reset` returns to. Absent means no. */
  promoteToSnapshot?: boolean;
  ownerEmail: string;
  documents: DocsWireDocument[];
}

export interface SeedRequest {
  twin: "google-docs";
  seed: DocsWireSeed;
}

/** `counts` is what was actually written, read back out of the DB. */
export interface SeedResult {
  ok: true;
  counts: { documents: number; paragraphs: number };
}

// ---------------------------------------------------------------------------
// Validated form. Parsing turns the wire into exactly this and nothing else, so
// the writer below cannot see an unchecked string.
// ---------------------------------------------------------------------------

/**
 * The LAST run already carries the terminating "\n". The parser is the one place
 * the index-space invariant is established for content arriving from outside, so
 * nothing downstream has to remember to add it.
 */
export interface ParsedParagraph {
  namedStyleType: string;
  runs: Array<{ content: string; bold: boolean; italic: boolean; link: string | null }>;
}

export interface ParsedDocument {
  id: string;
  title: string;
  ownerEmail: string;
  paragraphs: ParsedParagraph[];
}

export interface ParsedSeed {
  nowMs: number;
  ownerEmail: string;
  ownerName: string;
  businessName: string;
  promoteToSnapshot: boolean;
  documents: ParsedDocument[];
}

// ---------------------------------------------------------------------------
// Inject — one world beat: a colleague shares a brief, or edits a section.
// ---------------------------------------------------------------------------

export interface InjectDocumentSpec {
  /** The engine's own handle for this document, echoed back with the minted id. */
  slotId?: string;
  id?: string;
  title: string;
  ownerEmail?: string;
  paragraphs: DocsWireParagraph[];
}

export interface InjectEditSpec {
  documentId: string;
  appendParagraphs?: DocsWireParagraph[];
  replace?: Array<{ find: string; replaceWith: string; matchCase?: boolean }>;
}

export interface InjectRequest {
  documents?: InjectDocumentSpec[];
  edits?: InjectEditSpec[];
  atMs?: number;
  atISO?: string;
}

/** Structurally core's `InjectedRef` — the ids the engine threads later beats onto. */
export interface InjectResult {
  twin: "google-docs";
  documents: Array<{ slotId: string; documentId: string; revisionId: string }>;
  edits: Array<{ documentId: string; revisionId: string; occurrencesChanged: number }>;
}

// ---------------------------------------------------------------------------
// Snapshot — the workspace as the judge sees it.
// ---------------------------------------------------------------------------

export interface DocsSnapshotDocument {
  documentId: string;
  title: string;
  revisionId: string;
  /** The cast member the seed says owns it — who a diff is happening TO. */
  ownerEmail: string;
  /** The text of every TITLE/SUBTITLE/HEADING_* paragraph, in order, newline trimmed. */
  headings: string[];
  paragraphCount: number;
  /** layout.endIndex − 1: the body text length, the section break excluded. */
  characterCount: number;
  namedRanges: string[];
  isSandboxCreated: boolean;
  text: string;
  truncated: boolean;
}

export interface DocsTwinSnapshot {
  twin: "google-docs";
  documents: DocsSnapshotDocument[];
}
