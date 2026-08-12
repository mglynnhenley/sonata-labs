import { HEADING_STYLE_TYPES, NAMED_STYLE_TYPES } from "../docs/defaults";
import { newHeadingId } from "../docs/ids";
import type { ParagraphModel } from "../docs/shape";
import { BadRequestError } from "./auth";
import type { ParsedDocument, ParsedParagraph, ParsedSeed, WirePerson } from "./types";

// Validating a cloned business on the way in. Everything here fails loudly with a
// message that names the offending path AND says what to fix: a seed that is
// half-understood produces documents the agent quietly reasons about wrongly,
// which is far worse than a run that refuses to start.
//
// The rule doing the most work is cast membership. A twin must never invent an
// identity — the "Priya" who owns the 1:1 agenda is only the same person as the
// "Priya" in the inbox because both came out of `world.cast`.

/** Google Docs ids are 44 url-safe characters; a link in another twin carries one. */
const DOCUMENT_ID = /^[A-Za-z0-9_-]{20,60}$/;

export function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestError(`${where} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function array(source: Record<string, unknown>, key: string, where: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new BadRequestError(`${where}.${key} must be an array`);
  return value;
}

/** For the list fields a hand-written seed reasonably leaves off entirely. */
export function optionalArray(source: Record<string, unknown>, key: string, where: string): unknown[] {
  return source[key] === undefined || source[key] === null ? [] : array(source, key, where);
}

export function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestError(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

/** Absent, null and "" all mean "no value" for the optional prose fields. */
export function optionalText(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new BadRequestError(`${where}.${key} must be a string`);
  return value;
}

export function flag(source: Record<string, unknown>, key: string, where: string): boolean {
  const value = source[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new BadRequestError(`${where}.${key} must be a boolean`);
  return value;
}

function instant(source: Record<string, unknown>, key: string, where: string): number {
  const raw = text(source, key, where);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new BadRequestError(`${where}.${key} must be an absolute ISO 8601 timestamp, got "${raw}"`);
  }
  return ms;
}

function castOf(world: Record<string, unknown>): WirePerson[] {
  return array(world, "cast", "seed.world").map((entry, i) => {
    const where = `seed.world.cast[${i}]`;
    const person = object(entry, where);
    return {
      id: text(person, "id", where),
      name: text(person, "name", where),
      email: text(person, "email", where),
    };
  });
}

function namedStyleType(raw: Record<string, unknown>, where: string): string {
  const value = optionalText(raw, "namedStyleType", where) || "NORMAL_TEXT";
  if (!(NAMED_STYLE_TYPES as readonly string[]).includes(value)) {
    throw new BadRequestError(
      `${where}.namedStyleType "${value}" is not a Docs named style — use one of ` +
        NAMED_STYLE_TYPES.join(", "),
    );
  }
  return value;
}

/**
 * Shared with the inject route so a director's beat and a seeded document are the
 * same artifact, validated once. Appends the terminating "\n" to the last run of
 * every paragraph, which is where the index-space invariant enters the system for
 * anything authored outside this app.
 */
export function parseWireParagraphs(entries: unknown[], where: string): ParsedParagraph[] {
  if (!entries.length) {
    throw new BadRequestError(
      `${where} must contain at least one paragraph — a document always has one, ` +
        `and an empty body is not a state the Docs API can represent`,
    );
  }
  return entries.map((entry, j) => {
    const at = `${where}[${j}]`;
    const raw = object(entry, at);
    const hasText = raw.text !== undefined && raw.text !== null;
    const hasRuns = raw.runs !== undefined && raw.runs !== null;
    if (hasText === hasRuns) {
      throw new BadRequestError(`${at} must set either text or runs, not both and not neither`);
    }

    const wireRuns: Record<string, unknown>[] = hasRuns
      ? array(raw, "runs", at).map((r, k) => object(r, `${at}.runs[${k}]`))
      : [{ content: String(raw.text) }];

    const runs = wireRuns.map((run, k) => {
      const runAt = hasRuns ? `${at}.runs[${k}]` : at;
      const content = hasRuns ? text(run, "content", runAt) : String(run.content);
      if (content.includes("\n")) {
        throw new BadRequestError(
          `${runAt}.content contains a newline — a paragraph break is a new entry in ` +
            `paragraphs[], not a "\\n" inside a run`,
        );
      }
      const link = optionalText(run, "link", runAt);
      return {
        content,
        bold: flag(run, "bold", runAt),
        italic: flag(run, "italic", runAt),
        link: link || null,
      };
    });

    // The trailing newline goes on the LAST run. Every later index in the
    // document counts it, so establishing it once here is what keeps the seed
    // and an agent's own edits in the same arithmetic.
    runs[runs.length - 1] = {
      ...runs[runs.length - 1],
      content: runs[runs.length - 1].content + "\n",
    };
    return { namedStyleType: namedStyleType(raw, at), runs };
  });
}

/**
 * Validated paragraphs to the model the store writes. The wire speaks in
 * bold/italic/link because a scenario author does; the document speaks in
 * TextStyle, because that is what an agent reads back. A run with none of the
 * three carries a null style, which is the same thing as `textStyle: {}`.
 */
export function toParagraphModels(paragraphs: ParsedParagraph[]): ParagraphModel[] {
  return paragraphs.map((p) => ({
    namedStyleType: p.namedStyleType,
    // Seeded headings carry an anchor id exactly as real ones do, so an agent
    // cannot spot a seeded heading by the id it is missing.
    headingId: HEADING_STYLE_TYPES.includes(p.namedStyleType) ? newHeadingId() : null,
    alignment: null,
    extra: null,
    runs: p.runs.map((run) => {
      const style: Record<string, unknown> = {};
      if (run.bold) style.bold = true;
      if (run.italic) style.italic = true;
      if (run.link) style.link = { url: run.link };
      return { content: run.content, style: Object.keys(style).length ? style : null };
    }),
  }));
}

function parseDocuments(entries: unknown[], known: Map<string, string>): ParsedDocument[] {
  const seen = new Map<string, number>();
  return entries.map((entry, i) => {
    const where = `seed.documents[${i}]`;
    const raw = object(entry, where);

    const id = text(raw, "id", where);
    if (!DOCUMENT_ID.test(id)) {
      throw new BadRequestError(
        `${where}.id "${id}" is not a Google Docs id — those are 44 url-safe characters, ` +
          `and an agent that lifts one out of a docs.google.com link has to get the same string back`,
      );
    }
    const first = seen.get(id);
    if (first !== undefined) {
      throw new BadRequestError(
        `seed.documents[${first}] and ${where} share the id "${id}" — ids address documents, ` +
          `so two of them would make one unreachable`,
      );
    }
    seen.set(id, i);

    const ownerEmail = text(raw, "ownerEmail", where);
    if (!known.has(ownerEmail.toLowerCase())) {
      throw new BadRequestError(
        `${where}.ownerEmail "${ownerEmail}" is not in seed.world.cast — the document owner ` +
          `must be a member of the cast the other twins seeded from`,
      );
    }

    return {
      id,
      title: text(raw, "title", where),
      ownerEmail,
      paragraphs: parseWireParagraphs(array(raw, "paragraphs", where), `${where}.paragraphs`),
    };
  });
}

/** The whole request, checked. Throws `BadRequestError` with a fixable message. */
export function parseSeedRequest(body: unknown): ParsedSeed {
  const root = object(body, "body");

  // Redundant with the URL on purpose: a mis-routed seed has to be loud, because
  // the alternative is an empty document set that answers 200.
  if (root.twin !== "google-docs") {
    throw new BadRequestError(
      `this twin seeds 'google-docs', not ${JSON.stringify(root.twin)} — post the docs ` +
        `wire seed here and the others to their own twins`,
    );
  }

  const seed = object(root.seed, "seed");
  const world = object(seed.world, "seed.world");
  const cast = castOf(world);
  // email (lowercased) -> the cast's spelling of that person's name.
  const known = new Map(cast.map((p) => [p.email.toLowerCase(), p.name]));

  const ownerEmail = text(seed, "ownerEmail", "seed");
  const ownerName = known.get(ownerEmail.toLowerCase());
  if (ownerName === undefined) {
    throw new BadRequestError(
      `seed.ownerEmail "${ownerEmail}" is not in seed.world.cast — the document owner must be ` +
        `a member of the cast the other twins seeded from`,
    );
  }

  const business = object(world.business, "seed.world.business");
  const promote = seed.promoteToSnapshot;
  if (promote !== undefined && typeof promote !== "boolean") {
    throw new BadRequestError("seed.promoteToSnapshot must be a boolean when present");
  }

  return {
    nowMs: instant(seed, "nowISO", "seed"),
    ownerEmail,
    ownerName,
    businessName: text(business, "name", "seed.world.business"),
    promoteToSnapshot: promote === true,
    documents: parseDocuments(array(seed, "documents", "seed"), known),
  };
}
