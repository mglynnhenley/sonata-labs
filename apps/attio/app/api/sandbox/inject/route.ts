import { NextResponse } from "next/server";
import { BadRequestError, requireSandboxToken, sandboxError } from "@/lib/sandbox/auth";
import { liveDb } from "@/lib/sandbox/live";
import { newUuid } from "@/lib/attio/ids";
import { writeValues } from "@/lib/attio/values";
import type { Actor } from "@/lib/attio/shape";
import { getObjectBySlug } from "@/lib/store/objects";
import { getMemberByEmail } from "@/lib/store/members";
import { getOwnerMemberId } from "@/lib/store/meta";
import { getRecordRow, insertRecord } from "@/lib/store/records";
import { insertNote, markdownToPlaintext } from "@/lib/store/notes";
import { insertTask } from "@/lib/store/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The director's hand on the CRM: a new account appears, a deal moves, a note or
// a task lands.
//
// Deliberately NOT audit-logged — injection is scenario setup, not agent
// behaviour, and the judge reads the audit log to score the agent. The absence
// of a log row is the WHOLE distinction: an injected row is attributed to the
// workspace's own owner and carries no marker of its own, so inside the CRM it
// is indistinguishable from seed, which is exactly what a director wants when a
// beat has to read as the world's history rather than as something staged.

interface InjectRecord {
  ref?: string;
  object: string;
  values: Record<string, unknown>;
}

interface InjectUpdate {
  object: string;
  recordId: string;
  values: Record<string, unknown>;
}

interface InjectNote {
  ref?: string;
  parentObject: string;
  parentRecordId: string;
  title: string;
  content: string;
  format?: "plaintext" | "markdown";
}

interface InjectTask {
  ref?: string;
  content: string;
  deadlineAt?: string | null;
  linkedRecords?: Array<{ object: string; recordId: string }>;
  assigneeEmail?: string | null;
}

interface InjectBody {
  records?: InjectRecord[];
  updates?: InjectUpdate[];
  notes?: InjectNote[];
  tasks?: InjectTask[];
  atMs?: number;
  atISO?: string;
}

/**
 * Simulated time is required, never defaulted to Date.now(): a deal stamped with
 * wall-clock time inside a simulated Monday 9am makes the whole day incoherent
 * to the agent reading it.
 */
function resolveAtMs(body: InjectBody): number {
  if (typeof body.atMs === "number" && Number.isFinite(body.atMs)) return body.atMs;
  if (typeof body.atISO === "string") {
    const ms = Date.parse(body.atISO);
    if (!Number.isNaN(ms)) return ms;
    throw new BadRequestError(`inject: atISO "${body.atISO}" is not an ISO 8601 timestamp`);
  }
  throw new BadRequestError("inject: atMs or atISO is required");
}

export async function POST(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as InjectBody;
    const records = body.records ?? [];
    const updates = body.updates ?? [];
    const notes = body.notes ?? [];
    const tasks = body.tasks ?? [];
    if (!records.length && !updates.length && !notes.length && !tasks.length) {
      throw new BadRequestError("nothing to inject");
    }
    const atMs = resolveAtMs(body);

    const db = liveDb();
    const ownerMemberId = getOwnerMemberId(db);
    if (!ownerMemberId) throw new BadRequestError("no workspace owner — seed first");
    const actor: Actor = { type: "workspace-member", id: ownerMemberId };

    const requireObjectSlug = (slug: string) => {
      const object = getObjectBySlug(db, slug);
      if (!object) throw new BadRequestError(`inject: unknown object "${slug}"`);
      return object;
    };

    const madeRecords: Array<{ ref: string; id: string; object: string }> = [];
    const madeUpdates: Array<{ id: string; object: string }> = [];
    const madeNotes: Array<{ ref: string; id: string }> = [];
    const madeTasks: Array<{ ref: string; id: string }> = [];

    const apply = db.transaction(() => {
      for (const spec of records) {
        const object = requireObjectSlug(spec.object);
        const id = newUuid();
        insertRecord(db, { id, objectId: object.id, createdAtMs: atMs });
        writeValues(
          db,
          { recordId: id, objectId: object.id, objectSlug: object.api_slug },
          spec.values ?? {},
          { atMs, actor, mode: "create" },
        );
        madeRecords.push({ ref: spec.ref ?? id, id, object: object.api_slug });
      }

      for (const spec of updates) {
        const object = requireObjectSlug(spec.object);
        if (!getRecordRow(db, object.id, spec.recordId)) {
          throw new BadRequestError(`inject: unknown ${spec.object} record ${spec.recordId}`);
        }
        writeValues(
          db,
          { recordId: spec.recordId, objectId: object.id, objectSlug: object.api_slug },
          spec.values ?? {},
          { atMs, actor, mode: "append" },
        );
        madeUpdates.push({ id: spec.recordId, object: object.api_slug });
      }

      for (const spec of notes) {
        const object = requireObjectSlug(spec.parentObject);
        if (!getRecordRow(db, object.id, spec.parentRecordId)) {
          throw new BadRequestError(
            `inject: unknown ${spec.parentObject} record ${spec.parentRecordId}`,
          );
        }
        const id = newUuid();
        const markdown = spec.content ?? "";
        insertNote(db, {
          id,
          parentObject: object.api_slug,
          parentRecordId: spec.parentRecordId,
          title: spec.title,
          contentMarkdown: markdown,
          contentPlaintext:
            spec.format === "markdown" ? markdownToPlaintext(markdown) : markdown,
          actorType: "workspace-member",
          actorId: ownerMemberId,
          createdAtMs: atMs,
        });
        madeNotes.push({ ref: spec.ref ?? id, id });
      }

      for (const spec of tasks) {
        const links = (spec.linkedRecords ?? []).map((link) => {
          const object = requireObjectSlug(link.object);
          if (!getRecordRow(db, object.id, link.recordId)) {
            throw new BadRequestError(`inject: unknown ${link.object} record ${link.recordId}`);
          }
          return { targetObject: object.api_slug, targetRecordId: link.recordId };
        });
        let assignees: Array<{ actorType: string; actorId: string }> = [];
        if (spec.assigneeEmail) {
          const member = getMemberByEmail(db, spec.assigneeEmail);
          if (!member) {
            throw new BadRequestError(
              `inject: "${spec.assigneeEmail}" is not a workspace member`,
            );
          }
          assignees = [{ actorType: "workspace-member", actorId: member.id }];
        }
        const id = newUuid();
        insertTask(db, {
          id,
          contentPlaintext: spec.content,
          deadlineAt: spec.deadlineAt ?? null,
          isCompleted: false,
          completedAtMs: null,
          actorType: "workspace-member",
          actorId: ownerMemberId,
          createdAtMs: atMs,
          linkedRecords: links,
          assignees,
        });
        madeTasks.push({ ref: spec.ref ?? id, id });
      }
    });

    apply();
    // The ids are echoed back so the engine can thread the next beat onto them.
    return NextResponse.json({
      ok: true,
      records: madeRecords,
      updates: madeUpdates,
      notes: madeNotes,
      tasks: madeTasks,
    });
  } catch (err) {
    return sandboxError(err, err instanceof BadRequestError ? 400 : 500);
  }
}
