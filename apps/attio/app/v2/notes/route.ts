import {
  handleAttio,
  json,
  recordDisplayName,
  requireObject,
  requireRecord,
  runMutation,
} from "@/lib/attio/route-helpers";
import { badRequestError } from "@/lib/attio/errors";
import { newUuid } from "@/lib/attio/ids";
import { clampLimit, parseOffset } from "@/lib/attio/pagination";
import { shapeNote } from "@/lib/attio/shape";
import { getNoteRow, insertNote, listNoteRows, markdownToPlaintext } from "@/lib/store/notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET reads what is already on a record — which is also how a judge reads back
// what the agent wrote — and POST is "log a note against this record", the
// second headline write.

export function GET(req: Request) {
  return handleAttio(req, (ctx) => {
    const sp = new URL(req.url).searchParams;
    const parentObject = sp.get("parent_object");
    // Resolved through requireObject so an unknown slug is a 404 rather than an
    // empty list an agent would read as "there are no notes".
    const object = parentObject ? requireObject(ctx.db, parentObject) : null;
    const rows = listNoteRows(ctx.db, {
      parentObject: object?.api_slug,
      parentRecordId: sp.get("parent_record_id") || undefined,
      // 10 really is Attio's default here, and it is unusually small.
      limit: clampLimit(sp.get("limit"), 10, 50),
      offset: parseOffset(sp.get("offset")),
    });
    return json({ data: rows.map((row) => shapeNote(ctx, row)) });
  });
}

export function POST(req: Request) {
  return handleAttio(req, async (ctx) => {
    const { db } = ctx;
    const body = (await req.json().catch(() => ({}))) as {
      data?: {
        parent_object?: string;
        parent_record_id?: string;
        title?: string;
        format?: string;
        content?: string;
        created_at?: string;
      };
    };
    const data = body.data ?? {};
    if (!data.parent_object || !data.parent_record_id) {
      throw badRequestError("data.parent_object and data.parent_record_id are required.");
    }
    if (typeof data.title !== "string" || !data.title) {
      throw badRequestError("data.title is required.");
    }
    if (typeof data.content !== "string") {
      throw badRequestError("data.content is required.");
    }
    const format = data.format ?? "plaintext";
    if (format !== "plaintext" && format !== "markdown") {
      throw badRequestError(`data.format must be "plaintext" or "markdown", got "${format}".`);
    }
    const object = requireObject(db, data.parent_object);
    requireRecord(db, object.id, data.parent_record_id);

    // Attio lets a caller backdate a note; anything unparseable falls back to now
    // rather than failing, because a bad timestamp is not worth losing the note.
    const createdAt = data.created_at ? Date.parse(data.created_at) : NaN;
    const createdAtMs = Number.isNaN(createdAt) ? Date.now() : createdAt;
    const parentName = recordDisplayName(db, object.id, data.parent_record_id);
    const endpoint = new URL(req.url).pathname;
    const content = data.content;

    const id = runMutation(
      db,
      () => {
        const noteId = newUuid();
        insertNote(db, {
          id: noteId,
          parentObject: object.api_slug,
          parentRecordId: data.parent_record_id as string,
          title: data.title as string,
          // Markdown is stored verbatim and the plaintext is derived once, here:
          // re-deriving it per read would let a note's plaintext change under an
          // agent that already quoted it.
          contentMarkdown: content,
          contentPlaintext: format === "markdown" ? markdownToPlaintext(content) : content,
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
          createdAtMs,
        });
        return noteId;
      },
      (noteId) => ({
        method: "POST",
        endpoint,
        actionType: "noteCreate",
        targetType: "note",
        targetId: noteId,
        request: body,
        responseCode: 200,
        summary: `Logged note “${data.title}” on ${object.singular_noun} “${parentName}”`,
      }),
    );

    const row = getNoteRow(db, id);
    if (!row) throw new Error(`note ${id} vanished after insert`);
    return json({ data: shapeNote(ctx, row) });
  });
}
