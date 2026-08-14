import {
  owner,
  resolvePerson,
  resolveTwinApiUrl,
  type AgentTrace,
  type BeatBody,
  type DocsParagraphPayload,
  type EpisodeSpec,
  type GoogleDocsDiff,
  type GoogleDocsSnapshot,
  type InjectContext,
  type InjectedRef,
  type JudgeStep,
  type TwinAdapter,
  type TwinAuditRow,
  type TwinDiff,
  type TwinHealth,
  type TwinSnapshot,
} from "@sonata/core";
import { createTwinHttp, TwinHttpError, type TwinHttpOptions } from "../http";
import { projectTwinTrace } from "../project";
import { auditViaActivity, byKey, clip, healthViaApi, resetViaApi } from "./shared";

// The Google Docs twin, behind @sonata/core's TwinAdapter.
//
// One thing here departs from the other three, and it is forced: the Docs API has
// no list method — the vendor's does not have one either, because finding a
// document is Drive's job — so there is no public call that answers "what is in
// this workspace". apps/google-docs says so in as many words and refuses to fake
// one, since an agent that could list documents would stop finding them the way
// the product intends, through a link in an email or a Slack message. Capture
// therefore reads GET /api/sandbox/snapshot. That route is a projection of the
// same rows /v1/documents serves, field for field, so the property that matters —
// a snapshot can only see what the agent could have changed — still holds; what
// is lost is the round trip that would have proved the read path works, and
// health() plus the agent's own tools exercise that instead.
//
// The graded question on this surface is literally what the document says, so
// unlike the mailbox digest the text itself has to reach the judge. That makes
// the capture the expensive one of the four, hence two caps below, and a `diff`
// that reports the text which MOVED rather than the text that is there.

/** Documents per snapshot. The twin orders them most-recently-touched first, so
 *  the cap sheds the ones nobody has opened in longest — and a workspace bigger
 *  than this is a scenario bug rather than a bigger scenario. */
const MAX_DOCUMENTS = 25;

/**
 * Body text kept per document. Deliberately the same 4000 the twin's own
 * snapshot route caps at rather than something tighter: `diff` is pure and has
 * nothing to work from but these two strings, so every character dropped here is
 * an edit the judge cannot be shown.
 */
const MAX_EXCERPT = 4000;

/** The changed text carried into one diff row. Past this it is a document, not a change. */
const MAX_DIFF_EXCERPT = 600;

/** One document as GET /api/sandbox/snapshot returns it. */
interface DocsSnapshotDocument {
  documentId?: string;
  title?: string;
  revisionId?: string;
  ownerEmail?: string;
  text?: string;
  characterCount?: number;
}

/** POST /api/sandbox/inject's answer — `injected` is the twin's InjectResult. */
interface InjectResponse {
  ok?: boolean;
  error?: string;
  injected?: {
    documents?: Array<{ slotId?: string; documentId?: string; revisionId?: string }>;
    edits?: Array<{ documentId?: string; revisionId?: string; occurrencesChanged?: number }>;
  };
}

export interface GoogleDocsAdapterOptions extends Omit<TwinHttpOptions, "baseUrl"> {
  /** Defaults to the port the monorepo's `dev:google-docs` script uses. */
  baseUrl?: string;
}

export function createGoogleDocsAdapter(opts: GoogleDocsAdapterOptions = {}): TwinAdapter {
  const baseUrl = resolveTwinApiUrl("google-docs", process.env, { override: opts.baseUrl });
  const http = createTwinHttp("google-docs", { ...opts, baseUrl });

  /**
   * The wire form of a beat's paragraphs.
   *
   * The twin refuses a "\n" inside a run — in the Docs index space a paragraph
   * break IS a new entry in `paragraphs[]`, and accepting one would put every
   * later index out of step — so an authored blob becomes one entry per line
   * here rather than a 400 mid-episode. Only the first line keeps the style: a
   * three-line HEADING_1 is three headings, which nobody writing a beat means.
   */
  function wireParagraphs(paragraphs: DocsParagraphPayload[]): Array<Record<string, unknown>> {
    return paragraphs.flatMap((p) =>
      p.text.split("\n").map((line, i) => ({
        text: line,
        ...(i === 0 && p.namedStyleType ? { namedStyleType: p.namedStyleType } : {}),
      })),
    );
  }

  /**
   * The document a beat is pointing at, in the three spellings
   * `DocsDocumentTarget` documents: an earlier beat's `ref`, the document's
   * title, or its raw id.
   *
   * The registry is tried first, because a ref that happens to look like a title
   * is still a ref. The title lookup after it is what makes a seeded workspace
   * scriptable: a document the world laid down has a 44-character id hashed at
   * seed time and published nowhere an author reads, so without this an episode
   * could not say "a colleague revised the brief the day is about" — it would
   * have to create that brief with a document beat first, and the diff would then
   * read it as written during the day rather than as pre-existing.
   *
   * A ref that resolves to neither falls through as an id and the twin answers
   * `"…" is not a document in this workspace`, which names the authoring mistake
   * better than anything this side could.
   */
  async function documentFor(ref: string, ctx: InjectContext): Promise<string> {
    const made = ctx.resolve(ref);
    if (made) return made.id;

    const needle = ref.trim().toLowerCase();
    const res = await http.get<{ documents?: DocsSnapshotDocument[] }>("/api/sandbox/snapshot");
    for (const d of res.documents ?? []) {
      if (d.documentId && (d.title ?? "").trim().toLowerCase() === needle) return d.documentId;
    }
    return ref;
  }

  return {
    name: "google-docs",
    baseUrl,

    health(): Promise<TwinHealth> {
      return healthViaApi(http, "google-docs");
    },

    async snapshot(): Promise<TwinSnapshot> {
      const res = await http.get<{ documents?: DocsSnapshotDocument[] }>("/api/sandbox/snapshot");
      const documents: GoogleDocsSnapshot["documents"] = [];
      for (const d of res.documents ?? []) {
        if (!d.documentId || documents.length >= MAX_DOCUMENTS) continue;
        const text = d.text ?? "";
        documents.push({
          documentId: d.documentId,
          title: d.title ?? "",
          revisionId: d.revisionId ?? "",
          // Whose it is, so the judge can tell the agent's own draft from a
          // colleague's brief. The twin serves this per document.
          ownerEmail: d.ownerEmail ?? "",
          excerpt: clip(text, MAX_EXCERPT),
          // The twin's own count, which covers the whole body even when the text
          // above was cut — that difference is how `diff` knows it is holding the
          // head of a document rather than all of one.
          characterCount: d.characterCount ?? text.length,
        });
      }
      return { twin: "google-docs", capturedAt: Date.now(), documents };
    },

    diff(before: TwinSnapshot, after: TwinSnapshot): TwinDiff {
      return diffGoogleDocs(before as GoogleDocsSnapshot, after as GoogleDocsSnapshot);
    },

    renderDiff(diff: TwinDiff): string {
      return renderGoogleDocsDiff(diff as GoogleDocsDiff);
    },

    async inject(body: BeatBody, ctx: InjectContext): Promise<InjectedRef> {
      if (body.twin !== "google-docs") {
        throw new Error(`google-docs adapter cannot inject a ${body.twin} beat`);
      }

      // Everything the world does goes through the sandbox route, never
      // /v1/documents: the provider API audit-logs its writes and the engine
      // reads that log to decide what the AGENT did, so a colleague's brief
      // arriving that way would be scored as the agent having written it.
      // `atISO` is the simulated clock — a document stamped with wall-clock time
      // inside a simulated Monday makes the day incoherent to whoever reads it.
      const post = async (payload: Record<string, unknown>): Promise<InjectResponse> => {
        try {
          return await http.post<InjectResponse>("/api/sandbox/inject", {
            atISO: ctx.atISO,
            ...payload,
          });
        } catch (err) {
          if (err instanceof TwinHttpError && err.status === 404) {
            throw new Error(
              "The google-docs twin has no POST /api/sandbox/inject route. Scripted beats need " +
                "it: documents.create and batchUpdate write audit rows, which would score the " +
                "world's own moves as the agent's work.",
            );
          }
          throw err;
        }
      };

      if (body.kind === "document") {
        const p = body.payload;
        // Resolved through the cast rather than through `emailOf`, which falls
        // back to the ref itself for an outsider: a mistyped owner would become a
        // document owned by `mai`, an identity nobody in the world has. The seed
        // route already refuses an owner outside `world.cast` by name, and this
        // is the same rule on the beat path — `injectBody` turns it into a
        // recorded error on this one beat rather than a dead run.
        const docOwner = p.owner ? resolvePerson(ctx.world, p.owner) : undefined;
        if (p.owner && !docOwner) {
          throw new Error(
            `a document beat gives "${p.title}" the owner "${p.owner}", who is not in the cast ` +
              "— a twin must never invent an identity",
          );
        }
        const res = await post({
          documents: [
            {
              title: p.title,
              ...(docOwner ? { ownerEmail: docOwner.email } : {}),
              paragraphs: wireParagraphs(p.paragraphs),
            },
          ],
        });
        const created = res.injected?.documents?.[0];
        if (!created?.documentId) {
          throw new Error(res.error ?? "google-docs inject returned no document");
        }
        // No containerId: a document sits in no thread and no channel, and this
        // clone models no Drive folders to put one in.
        return { twin: "google-docs", id: created.documentId };
      }

      const documentId = await documentFor(body.payload.documentRef, ctx);

      if (body.kind === "append") {
        await post({
          edits: [{ documentId, appendParagraphs: wireParagraphs(body.payload.paragraphs) }],
        });
        // The handle is the document itself: an appended paragraph has no
        // identity of its own in the Docs API, so a later beat naming this one
        // means "that document".
        return { twin: "google-docs", id: documentId };
      }

      const p = body.payload;
      const res = await post({
        edits: [
          {
            documentId,
            replace: [
              {
                find: p.find,
                replaceWith: p.replaceWith,
                ...(p.matchCase ? { matchCase: true } : {}),
              },
            ],
          },
        ],
      });
      // A replacement that matched nothing is a beat that did not happen, and it
      // answers 200. Left quiet, the day would go on believing the placeholder
      // was filled in and every criterion resting on it would fail for reasons
      // nobody could see.
      if (!res.injected?.edits?.[0]?.occurrencesChanged) {
        throw new Error(
          `"${p.find}" appears nowhere in document ${documentId}, so the beat changed nothing`,
        );
      }
      return { twin: "google-docs", id: documentId };
    },

    /**
     * Seeds the cast and an empty workspace — the same cast-only deal the other
     * twins get, with the day's own documents arriving as beats.
     *
     * Built here rather than through `seedViaApi`, because `seedBodyFor`'s
     * fallthrough is Slack's shape and a docs seed posted in it is a 400 that
     * reads like a broken twin. The twin checks every owner against `world.cast`,
     * so a seed built from another world fails loudly instead of leaving a
     * workspace whose people are not the inbox's people.
     */
    async seed(spec: EpisodeSpec): Promise<void> {
      const world = spec.world;
      const me = owner(world);
      try {
        await http.post("/api/sandbox/seed", {
          twin: "google-docs",
          seed: {
            world,
            nowISO: new Date(Date.parse(spec.clock.startISO) || Date.now()).toISOString(),
            promoteToSnapshot: true,
            ownerEmail: me.email,
            documents: [],
          },
        });
      } catch (err) {
        if (err instanceof TwinHttpError && err.status === 404) {
          throw new Error(
            "The google-docs twin has no POST /api/sandbox/seed route, so the world could not " +
              "be loaded into it. Seed it out of band and run with seedWorld: false.",
          );
        }
        throw err;
      }
    },

    reset(): Promise<void> {
      return resetViaApi(http, "episode reset");
    },

    auditSince(sinceId: number): Promise<TwinAuditRow[]> {
      return auditViaActivity(http, "google-docs", sinceId, { sinceId, limit: 1000 });
    },

    projectTrace(trace: AgentTrace): JudgeStep[] {
      return projectTwinTrace(trace, "google-docs");
    },
  };
}

// ---------------------------------------------------------------------------
// Diff — pure. Keyed by documentId, which survives an edit and a retitle; a
// title does not, and the text certainly does not.
//
// There is no removal arm because there is no way to remove a document: the Docs
// API has no delete method and neither does the clone, so a document missing from
// the later capture fell out of MAX_DOCUMENTS rather than out of the world, and
// reporting that as a deletion would invent the one action nobody can take. The
// mirror image is the one place this can misread — a document past the cap that
// an edit lifted back into view reads as `created` — and it is left rather than
// guessed at, because both captures are ordered by last touch and a workspace
// deep enough for that is over the cap the twin itself calls a scenario bug.
// ---------------------------------------------------------------------------

type CapturedDocument = GoogleDocsSnapshot["documents"][number];

const byTitle = byKey<{ title: string; documentId: string }>((d) => `${d.title}\0${d.documentId}`);

export function diffGoogleDocs(
  before: GoogleDocsSnapshot,
  after: GoogleDocsSnapshot,
): GoogleDocsDiff {
  const beforeById = new Map(before.documents.map((d) => [d.documentId, d]));

  const created: GoogleDocsDiff["created"] = [];
  const edited: GoogleDocsDiff["edited"] = [];
  const renamed: GoogleDocsDiff["renamed"] = [];
  let unchangedCount = 0;

  for (const doc of after.documents) {
    const prev = beforeById.get(doc.documentId);
    if (!prev) {
      created.push({ documentId: doc.documentId, title: doc.title, ownerEmail: doc.ownerEmail });
      continue;
    }

    let touched = false;
    // Nothing in this clone renames a document — the vendor does it through
    // Drive, which apps/google-docs deliberately does not serve — so this stays
    // empty today. It is computed anyway because the alternative, folding a
    // title change into `edited`, would report a retitle as text that moved.
    if (prev.title !== doc.title) {
      renamed.push({ documentId: doc.documentId, from: prev.title, to: doc.title });
      touched = true;
    }

    const delta = bodyDelta(prev, doc);
    // A revision that moved with no text behind it is a paragraph promoted to a
    // heading, or a named range dropped on a passage. It is still an edit, and
    // an agent that only restyled must not read as having done nothing.
    if (delta.changed || prev.revisionId !== doc.revisionId) {
      edited.push({
        documentId: doc.documentId,
        title: doc.title,
        ownerEmail: doc.ownerEmail,
        charactersAdded: delta.charactersAdded,
        charactersRemoved: delta.charactersRemoved,
        excerpt: delta.changed
          ? delta.excerpt
          : "[a new revision that left the text as it was — styling or structure]",
        ...(delta.approximate ? { approximate: true } : {}),
      });
      touched = true;
    }

    // Counted, never listed. A workspace is overwhelmingly untouched by one
    // day's work, and spelling out the untouched part is how a judge prompt goes
    // from a page to a novel.
    if (!touched) unchangedCount++;
  }

  return {
    twin: "google-docs",
    created: created.sort(byTitle),
    edited: edited.sort(byTitle),
    renamed: renamed.sort(byKey((r) => `${r.to}\0${r.documentId}`)),
    unchangedCount,
  };
}

interface BodyDelta {
  charactersAdded: number;
  charactersRemoved: number;
  excerpt: string;
  /** Whether the captured text moved at all — a same-length rewrite counts. */
  changed: boolean;
  /** The counts are the twin's net figure, because one side was truncated. */
  approximate?: boolean;
}

/**
 * What moved between two captures of one document's body.
 *
 * The common head and tail are trimmed off, so what is left is the passage that
 * actually changed: an agent that fills in one placeholder in a five-page brief
 * shows up as the six words it wrote, not as five pages.
 */
function bodyDelta(before: CapturedDocument, after: CapturedDocument): BodyDelta {
  const a = before.excerpt;
  const b = after.excerpt;
  const prefix = commonPrefix(a, b);

  if (a.length < before.characterCount || b.length < after.characterCount) {
    // A capped excerpt is the HEAD of a document, so its tail moved only because
    // the cap did. Trimming a common tail off two heads cut in different places
    // would report most of the document as rewritten, so a truncated capture
    // falls back to the length the twin itself reported — which can only see the
    // net change, and reads a same-length rewrite as no characters at all.
    const net = after.characterCount - before.characterCount;
    const seen = b.slice(prefix);
    return {
      charactersAdded: Math.max(net, 0),
      charactersRemoved: Math.max(-net, 0),
      excerpt: seen
        ? clip(collapse(seen), MAX_DIFF_EXCERPT)
        : `[the change falls past the first ${b.length} characters captured]`,
      changed: a !== b || net !== 0,
      // Said in the row rather than left to be inferred from an excerpt: these
      // two counts are a net figure, and a judge reading one as exact would
      // conclude the agent wrote less than it did.
      approximate: true,
    };
  }

  const suffix = commonSuffix(a, b, prefix);
  const removedText = a.slice(prefix, a.length - suffix);
  const addedText = b.slice(prefix, b.length - suffix);
  return {
    charactersAdded: addedText.length,
    charactersRemoved: removedText.length,
    // What the document GAINED, because the graded question on this surface is
    // what it says now; what it lost is carried as a count. A pure deletion
    // names what went, or it would render as a blank line. Square brackets are
    // this file's mark for a note nobody wrote into the document.
    excerpt: addedText
      ? clip(collapse(addedText), MAX_DIFF_EXCERPT)
      : removedText
        ? `[deleted] ${clip(collapse(removedText), MAX_DIFF_EXCERPT)}`
        : "",
    changed: a !== b,
  };
}

/** Paragraph breaks become spaces, so one edit stays one line in the render. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  // Never cut between the halves of a surrogate pair. Half a pair is not a
  // character — it reads back as U+FFFD — and the twin's index space is counted
  // in code units precisely so an emoji survives an edit intact.
  return i > 0 && isHighSurrogate(a.charCodeAt(i - 1)) ? i - 1 : i;
}

/** Trailing characters the two share, never reaching back past `floor`. */
function commonSuffix(a: string, b: string, floor: number): number {
  const max = Math.min(a.length, b.length) - floor;
  let i = 0;
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  // Same guard from the other end: a tail starting on a low surrogate has left
  // its high half behind in the changed middle.
  return i > 0 && isLowSurrogate(a.charCodeAt(a.length - i)) ? i - 1 : i;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function renderGoogleDocsDiff(diff: GoogleDocsDiff): string {
  const lines: string[] = [];
  for (const d of diff.created) lines.push(`+ created "${d.title}" owned by ${d.ownerEmail}`);
  for (const d of diff.renamed) lines.push(`~ renamed "${d.from}" → "${d.to}"`);
  for (const d of diff.edited) {
    const counts: string[] = [];
    if (d.charactersAdded) counts.push(`+${d.charactersAdded}`);
    if (d.charactersRemoved) counts.push(`-${d.charactersRemoved}`);
    const size = counts.length ? `${counts.join("/")} characters` : "no text change";
    // The whose and the how-exact both go on the line: an agent that rewrote a
    // colleague's brief and one that filled in its own draft are different
    // findings, and a net count read as an exact one understates the second.
    const net = d.approximate ? " net, on a document captured only in part" : "";
    lines.push(
      `~ edited "${d.title}" (${d.ownerEmail}) ${size}${net}${d.excerpt ? ` — ${d.excerpt}` : ""}`,
    );
  }
  lines.push(`${diff.unchangedCount} document(s) untouched`);
  return lines.join("\n");
}
