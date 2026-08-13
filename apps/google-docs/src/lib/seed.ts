import type { Database } from "better-sqlite3";
import { HEADING_STYLE_TYPES } from "./docs/defaults";
import { newHeadingId, seededRevisionId } from "./docs/ids";
import { layout } from "./docs/index-space";
import type { ParagraphModel } from "./docs/shape";
import { insertDocument, loadDocument } from "./store/documents";
import { setMeta } from "./store/meta";

// The synthetic demo world, so the clone runs with no orchestrator and no real
// Google account.
//
// Deliberately shares people, domains and the anchor week with the Gmail and
// Calendar twins' seeds (sandbox.user@gmail.com, priya@acme.co, Acme), so a
// cloned business is coherent across surfaces: each of these documents is the one
// an event description or a mail thread in those clones already points at. A
// clone seeded with its own invented people is a fourth fixture, not a fourth
// surface of one company.

const OWNER_EMAIL = "sandbox.user@gmail.com";
const OWNER_NAME = "Sandbox User";

/** 09:00 America/New_York on the anchor Monday the Calendar twin uses. Fixed so
 * seeds are reproducible run to run. */
const ANCHOR_MS = Date.UTC(2026, 6, 27, 13, 0, 0);
const DAY_MS = 86_400_000;

/** The document behind Calendar's Tuesday QBR. */
const QBR_DOCUMENT_ID = "1QbrAcme3xR7pLmN9vKdT2wYzHf4JsU6eXo0BnCgVaMi";

/** The literal an agent is asked to fill in — present twice in the QBR document.
 * Exported because the smoke harness asserts on it and a second spelling of it
 * there would pass while the seed said something else. */
export const SEED_PLACEHOLDER = "[[HEADCOUNT]]";

interface SeedRun {
  content: string;
  bold?: boolean;
}

interface SeedParagraph {
  style?: string;
  text?: string;
  runs?: SeedRun[];
}

interface SeedDocument {
  id: string;
  title: string;
  /** How many days before the anchor the document was authored. */
  createdOffsetDays: number;
  paragraphs: SeedParagraph[];
  /** Spans given as paragraph positions, resolved to indexes after the write.
   * The id is written out rather than minted so re-seeding is byte-identical. */
  namedRanges?: Array<{ id: string; name: string; fromParagraph: number; toParagraph: number }>;
}

const SEED_DOCUMENTS: SeedDocument[] = [
  {
    id: QBR_DOCUMENT_ID,
    title: "Q3 Business Review — draft",
    createdOffsetDays: 7,
    paragraphs: [
      { style: "TITLE", text: "Q3 Business Review — draft" },
      { style: "HEADING_1", text: "Numbers" },
      {
        text: "Revenue closed at 4.1M, up 9% quarter over quarter. Churn held flat at 1.8%, which is the first quarter it has not moved.",
      },
      { style: "HEADING_1", text: "Headcount" },
      {
        text: "We are carrying [[HEADCOUNT]] open roles into Q4, and [[HEADCOUNT]] of them are backfills rather than growth.",
      },
      { text: "Owner for this section: [[OWNER]]." },
      { style: "HEADING_1", text: "Open risks" },
      {
        text: "The Northwind renewal, the audit evidence checklist, and the payments incident written up separately.",
      },
    ],
  },
  {
    id: "1NwiNcidentNotes8kQzR3mVbXpL7yTaJ2fUdCe0HsZk",
    title: "Northwind escalation — incident notes",
    createdOffsetDays: 7,
    paragraphs: [
      { style: "HEADING_1", text: "Timeline" },
      {
        // Three runs, the middle one bold: a clone that returns one run per
        // paragraph teaches an agent that elements[0] is the whole paragraph,
        // which is false against the real API.
        runs: [
          { content: "Since Thursday morning " },
          { content: "payments have been failing", bold: true },
          { content: " for roughly 3% of Northwind's checkout traffic." },
        ],
      },
      { style: "HEADING_1", text: "Next steps" },
      { text: "Priya owns the customer comms. Dan is draining the retry queue." },
    ],
  },
  {
    id: "1OneOnOnePriyaSandbox5tWkR9zXmB3vLqDeHf7JaTv",
    title: "Weekly 1:1 — Priya / Sandbox",
    createdOffsetDays: 7,
    paragraphs: [
      { style: "SUBTITLE", text: "Standing agenda — bring one thing you are stuck on" },
      { text: "Q3 review prep, and who presents which section." },
      { text: "Northwind escalation: what we tell the customer on Friday." },
      { text: "Hiring loop for the two backfills." },
      { text: "Anything from you." },
    ],
  },
  {
    id: "1AuditEvidenceChecklist2mRzKp8vXwB5nQtLdHeGy",
    title: "Audit evidence checklist",
    createdOffsetDays: 2,
    paragraphs: [
      { style: "HEADING_1", text: "Evidence still outstanding" },
      { text: "Access review exports for the production database." },
      { text: "Change management tickets covering the June deploy freeze." },
      { text: "Vendor questionnaires from Northwind and two others." },
    ],
    namedRanges: [
      { id: "kix.evidenceown1", name: "Evidence owners", fromParagraph: 1, toParagraph: 2 },
    ],
  },
  {
    id: "1EngOnboardingBrief7qWzN4mXvR2kBpLtJdHc0FaWu",
    title: "Engineering onboarding brief",
    createdOffsetDays: 2,
    paragraphs: [
      { style: "TITLE", text: "Engineering onboarding brief" },
      // The emoji is deliberate: it costs two UTF-16 indexes, so the seed itself
      // exercises the rule a naive implementation gets wrong.
      { text: "Day one is laptop, VPN and a walk through the deploy pipeline 😄" },
      { text: "Day two you ship something small to production, with Mei watching." },
    ],
  },
];

function toParagraphModel(p: SeedParagraph): ParagraphModel {
  const style = p.style ?? "NORMAL_TEXT";
  const runs = (p.runs ?? [{ content: p.text ?? "" }]).map((run) => ({
    content: run.content,
    style: run.bold ? { bold: true } : null,
  }));
  // The trailing newline lives on the LAST run; every index in the document
  // counts it.
  runs[runs.length - 1] = {
    ...runs[runs.length - 1],
    content: runs[runs.length - 1].content + "\n",
  };
  return {
    namedStyleType: style,
    headingId: HEADING_STYLE_TYPES.includes(style) ? newHeadingId() : null,
    alignment: null,
    runs,
  };
}

/** Populate an empty (schema-applied) database with the synthetic workspace. */
export function seedDatabase(db: Database): void {
  setMeta(db, "owner_email", OWNER_EMAIL);
  setMeta(db, "owner_name", OWNER_NAME);
  setMeta(db, "seeded_at", String(ANCHOR_MS));

  for (const doc of SEED_DOCUMENTS) {
    insertDocument(db, {
      id: doc.id,
      title: doc.title,
      ownerEmail: OWNER_EMAIL,
      revisionId: seededRevisionId(doc.id, ANCHOR_MS),
      paragraphs: doc.paragraphs.map(toParagraphModel),
      createdMs: ANCHOR_MS - doc.createdOffsetDays * DAY_MS,
      updatedMs: ANCHOR_MS,
      isSandboxCreated: false,
    });

    if (!doc.namedRanges?.length) continue;
    // Indexes are computed from the written document rather than hand-counted —
    // a hand-counted index goes stale the moment anyone edits the prose above it.
    // Just inserted, so the load cannot miss.
    const spans = layout(loadDocument(db, doc.id)!).paragraphs;
    for (const range of doc.namedRanges) {
      db.prepare(
        "INSERT INTO named_ranges (id, document_id, name, start_index, end_index) VALUES (?, ?, ?, ?, ?)",
      ).run(
        range.id,
        doc.id,
        range.name,
        spans[range.fromParagraph].startIndex,
        spans[range.toParagraph].endIndex,
      );
    }
  }
}
