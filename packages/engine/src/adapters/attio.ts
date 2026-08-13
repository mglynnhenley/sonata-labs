import { createHash } from "node:crypto";
import {
  emailOf,
  owner,
  resolveTwinApiUrl,
  type AgentTrace,
  type AttioDiff,
  type AttioSnapshot,
  type BeatBody,
  type EpisodeSpec,
  type InjectContext,
  type InjectedRef,
  type JudgeStep,
  type PersonRef,
  type TwinAdapter,
  type TwinAuditRow,
  type TwinDiff,
  type TwinHealth,
  type TwinSnapshot,
} from "@sonata/core";
import { createTwinHttp, TwinHttpError, type TwinHttpOptions } from "../http";
import { projectTwinTrace } from "../project";
import { auditViaActivity, byKey, clip, healthViaApi, resetViaApi } from "./shared";

// The Attio twin, behind @sonata/core's TwinAdapter.
//
// The thing that makes this surface different from the other three is that a
// value is never overwritten: the twin closes the current row and opens a new
// one, so the CRM holds the whole history of every attribute. A snapshot is a
// MOMENT, so it takes only the active value per attribute and renders it to a
// string — the history stays in the twin, where it belongs, and the question the
// judge actually asks ("what did the agent change, and from what") is answered
// by diffing two moments rather than by shipping a version log twice per run.
//
// Capture goes through the same `/v2` surface the agent's tools use, so a
// snapshot can only ever see what the agent could have changed, and `diff` /
// `renderDiff` are pure, so a finished run can be re-diffed months later with
// nothing running.

/**
 * The objects this CRM has. Hard-coded because object CRUD is deliberately out
 * of scope in the twin — there is no `GET /v2/objects` to enumerate — and
 * because the seed installs exactly these three and nothing can add a fourth.
 */
const OBJECTS = ["companies", "people", "deals"] as const;

/** What a person calls one of them, for the diff's prose. */
const SINGULAR: Record<string, string> = {
  companies: "company",
  people: "person",
  deals: "deal",
};

/**
 * Records captured per object. Two snapshots ship inside every run artifact and
 * live there forever, so this is capped rather than drained; newest-first, so
 * the cap sheds the accounts least likely to be part of today's work. A cloned
 * company's CRM is tens of records, not thousands, so it will not normally bite.
 */
const MAX_RECORDS_PER_OBJECT = 200;

/** Notes per snapshot, across every record. The twin pages them newest-first. */
const MAX_NOTES = 100;

/** Attio's own page size for notes, and it really is this small. */
const NOTES_PAGE = 50;

/** Tasks per snapshot — the owner's follow-up list, not a work queue. */
const MAX_TASKS = 200;

/** A note body is prose of any length; the judge gets the opening of it. */
const MAX_EXCERPT = 200;

// ---------------------------------------------------------------------------
// The `/v2` resources this adapter reads, narrowed to the fields it uses.
// ---------------------------------------------------------------------------

/** One active value. `attribute_type` is what decides how to read the rest. */
interface AttioValue {
  attribute_type?: string;
  value?: string | null;
  full_name?: string;
  email_address?: string;
  domain?: string;
  target_object?: string | null;
  target_record_id?: string | null;
  status?: { title?: string } | null;
  currency_value?: number | null;
  currency_code?: string | null;
  referenced_actor_type?: string | null;
  referenced_actor_id?: string | null;
}

export interface AttioRecordResource {
  id?: { record_id?: string };
  created_at?: string;
  web_url?: string;
  /** Keyed by attribute slug; the array holds one entry per active value. */
  values?: Record<string, AttioValue[]>;
}

interface NoteResource {
  id?: { note_id?: string };
  parent_object?: string;
  parent_record_id?: string;
  title?: string;
  content_plaintext?: string;
}

interface TaskResource {
  id?: { task_id?: string };
  content_plaintext?: string;
  deadline_at?: string | null;
  is_completed?: boolean;
  assignees?: Array<{ referenced_actor_type?: string; referenced_actor_id?: string }>;
}

interface MemberResource {
  id?: { workspace_member_id?: string };
  email_address?: string;
}

/**
 * The two lookups that turn a UUID into something a person can read: a record
 * reference into the referenced record's own name, and an actor reference into
 * the workspace member's email. Both are captured in the same pass as the
 * records they annotate, so a snapshot never says `workspace-member/8ccc6446…`
 * where it could say `priya@acme.com`.
 */
export interface Names {
  titles: Map<string, string>;
  members: Map<string, string>;
}

/**
 * One value as a person would say it.
 *
 * The default arm covers `text` and anything the twin's attribute vocabulary
 * grows later: every value carries a `value` field unless its type replaces it
 * with something richer, so an unrecognised type degrades to the plain string
 * rather than to nothing.
 */
function renderValue(v: AttioValue, names: Names): string {
  switch (v.attribute_type) {
    case "personal-name":
      return v.full_name ?? "";
    case "email-address":
      return v.email_address ?? "";
    case "domain":
      return v.domain ?? "";
    case "status":
      return v.status?.title ?? "";
    case "currency":
      return v.currency_value === null || v.currency_value === undefined
        ? ""
        : `${v.currency_value}${v.currency_code ? ` ${v.currency_code}` : ""}`;
    case "record-reference": {
      const id = v.target_record_id ?? "";
      return names.titles.get(id) ?? `${v.target_object ?? "record"}/${id}`;
    }
    case "actor-reference": {
      const id = v.referenced_actor_id ?? "";
      return names.members.get(id) ?? `${v.referenced_actor_type ?? "actor"}/${id}`;
    }
    default:
      return v.value ?? "";
  }
}

/**
 * A record's attribute bag, flattened to one string per attribute.
 *
 * A multiselect attribute holds several active rows at once — a company's
 * domains, a deal's people — and they join with a comma in the twin's own `pos`
 * order, so the flattening is stable across two captures of an untouched record
 * and the diff below does not report a reordering as a change.
 */
function flattenValues(resource: AttioRecordResource, names: Names): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slug, list] of Object.entries(resource.values ?? {})) {
    const rendered = (list ?? []).map((v) => renderValue(v, names)).filter(Boolean);
    if (rendered.length) out[slug] = rendered.join(", ");
  }
  return out;
}

/**
 * What a human calls this record. Attio treats an object's first attribute as
 * its display name, and on all three of this CRM's objects that attribute is
 * `name` — so the snapshot reads it directly rather than through an object
 * configuration endpoint the twin does not serve.
 */
function displayName(resource: AttioRecordResource, recordId: string): string {
  const empty: Names = { titles: new Map(), members: new Map() };
  const rendered = (resource.values?.name ?? []).map((v) => renderValue(v, empty)).filter(Boolean);
  return rendered.join(" ") || recordId;
}

/**
 * A record as everything downstream reads it: an id, the name a person calls it,
 * and its live attributes as strings.
 *
 * Exported because the agent's tools shape a record the same way. Those two
 * readings must not drift — an agent told a deal's stage is "In Progress" and a
 * judge shown "status/8ccc…" for the same row would be arguing about different
 * CRMs — and one function is what makes that impossible rather than merely
 * unlikely.
 */
export function describeRecord(
  resource: AttioRecordResource,
  names: Names,
): { recordId: string; title: string; values: Record<string, string> } {
  const recordId = resource.id?.record_id ?? "";
  return {
    recordId,
    title: displayName(resource, recordId),
    values: flattenValues(resource, names),
  };
}

// ---------------------------------------------------------------------------
// Beats. Declared here because core's `BeatBody` does not carry an Attio arm
// yet — see this adapter's report. The shapes are the proposal: four kinds that
// map one-for-one onto what the twin's POST /api/sandbox/inject accepts, so
// moving them into core is a cut-and-paste and nothing here changes.
// ---------------------------------------------------------------------------

/** What a spec may write into an attribute: the twin normalises all three. */
export type AttioWriteValue = string | number | Array<string | number>;

export interface AttioRecordPayload {
  /** "companies", "people" or "deals". */
  object: string;
  /** Keyed by attribute slug, e.g. `{name: "Northwind", domains: ["nw.example"]}`. */
  values: Record<string, AttioWriteValue>;
}

export interface AttioUpdatePayload {
  /**
   * The beat that created the record, by its `ref` — or the record id the world
   * was seeded with, for an account no beat minted.
   */
  recordRef: string;
  object: string;
  /** A stage move is `{stage: "Won 🎉"}`; any attribute works the same way. */
  values: Record<string, AttioWriteValue>;
}

export interface AttioNotePayload {
  parentObject: string;
  parentRecordRef: string;
  title: string;
  content: string;
  format?: "plaintext" | "markdown";
}

export interface AttioTaskPayload {
  content: string;
  deadlineISO?: string;
  /** Who it lands on. Must be someone in the cast, since the CRM seeds from it. */
  assignee?: PersonRef;
  linkedRecords?: Array<{ object: string; recordRef: string }>;
}

/**
 * One update kind rather than a `stage` kind and a `rename` kind: on this
 * surface every attribute is written the same way — the current row is closed
 * and a new one opens — so splitting by attribute would be four names for one
 * behaviour, and the first attribute an episode wanted that nobody had named
 * would be unreachable.
 */
export type AttioBeatBody =
  | { twin: "attio"; kind: "record"; payload: AttioRecordPayload }
  | { twin: "attio"; kind: "update"; payload: AttioUpdatePayload }
  | { twin: "attio"; kind: "note"; payload: AttioNotePayload }
  | { twin: "attio"; kind: "task"; payload: AttioTaskPayload };

/**
 * The beat this adapter was handed, or a loud refusal.
 *
 * The argument is deliberately wider than `TwinAdapter.inject`'s: core's
 * `BeatBody` has no Attio arm, so inside `inject` the twin discriminant can only
 * be narrowed against a union that admits one.
 */
function asAttioBeat(body: BeatBody | AttioBeatBody): AttioBeatBody {
  if (body.twin !== "attio") throw new Error(`attio adapter cannot inject a ${body.twin} beat`);
  return body;
}

/** What POST /api/sandbox/inject echoes back, so a later beat can find it. */
interface InjectResult {
  records?: Array<{ ref: string; id: string; object: string }>;
  updates?: Array<{ id: string; object: string }>;
  notes?: Array<{ ref: string; id: string }>;
  tasks?: Array<{ ref: string; id: string }>;
}

export interface AttioAdapterOptions extends Omit<TwinHttpOptions, "baseUrl"> {
  baseUrl?: string;
}

export function createAttioAdapter(opts: AttioAdapterOptions = {}): TwinAdapter {
  const baseUrl = resolveTwinApiUrl("attio", process.env, { override: opts.baseUrl });
  const http = createTwinHttp("attio", { ...opts, baseUrl });

  async function captureMembers(): Promise<Map<string, string>> {
    const res = await http.get<{ data?: MemberResource[] }>("/v2/workspace_members");
    const out = new Map<string, string>();
    for (const m of res.data ?? []) {
      const id = m.id?.workspace_member_id;
      if (id && m.email_address) out.set(id, m.email_address);
    }
    return out;
  }

  async function captureRecords(members: Map<string, string>): Promise<AttioSnapshot["records"]> {
    const raw: Array<{ object: string; recordId: string; resource: AttioRecordResource }> = [];
    for (const object of OBJECTS) {
      const res = await http.post<{ data?: AttioRecordResource[] }>(
        `/v2/objects/${object}/records/query`,
        {
          limit: MAX_RECORDS_PER_OBJECT,
          sorts: [{ attribute: "created_at", direction: "desc" }],
        },
      );
      for (const resource of res.data ?? []) {
        const recordId = resource.id?.record_id;
        if (recordId) raw.push({ object, recordId, resource });
      }
    }

    // Titles first, across every object, because a deal's company reference
    // points at a record captured in a different pass — resolving references as
    // we went would leave whichever object came first naming UUIDs.
    const names: Names = {
      titles: new Map(raw.map((e) => [e.recordId, displayName(e.resource, e.recordId)])),
      members,
    };
    return raw.map((e) => ({ object: e.object, ...describeRecord(e.resource, names) }));
  }

  async function captureNotes(): Promise<AttioSnapshot["notes"]> {
    const out: AttioSnapshot["notes"] = [];
    for (let offset = 0; out.length < MAX_NOTES; offset += NOTES_PAGE) {
      const res = await http.get<{ data?: NoteResource[] }>("/v2/notes", {
        limit: NOTES_PAGE,
        offset,
      });
      const page = res.data ?? [];
      for (const n of page) {
        const noteId = n.id?.note_id;
        if (!noteId || out.length >= MAX_NOTES) continue;
        out.push({
          noteId,
          parentObject: n.parent_object ?? "",
          parentRecordId: n.parent_record_id ?? "",
          title: n.title ?? "",
          excerpt: clip(n.content_plaintext ?? "", MAX_EXCERPT),
        });
      }
      if (page.length < NOTES_PAGE) break;
    }
    return out;
  }

  async function captureTasks(members: Map<string, string>): Promise<AttioSnapshot["tasks"]> {
    // Newest-first, like the records and the notes, and for a sharper reason: the
    // twin's default is oldest-first, so a capped capture of a long follow-up
    // list would shed the newest tasks — which are precisely the ones the run
    // just raised. The diff would then report that the agent raised nothing.
    const res = await http.get<{ data?: TaskResource[] }>("/v2/tasks", {
      limit: MAX_TASKS,
      sort: "created_at:desc",
    });
    const out: AttioSnapshot["tasks"] = [];
    for (const t of res.data ?? []) {
      const taskId = t.id?.task_id;
      if (!taskId) continue;
      out.push({
        taskId,
        content: t.content_plaintext ?? "",
        isCompleted: t.is_completed === true,
        ...(t.deadline_at ? { deadlineISO: t.deadline_at } : {}),
        // Emails rather than member ids: "assigned to nobody the judge can
        // name" is the only thing a UUID here would say.
        assignees: (t.assignees ?? [])
          .map((a) => (a.referenced_actor_id ? members.get(a.referenced_actor_id) ?? a.referenced_actor_id : ""))
          .filter(Boolean),
      });
    }
    return out;
  }

  /**
   * One beat into the CRM, stamped with simulated time.
   *
   * Everything the world does goes through this route rather than through `/v2`,
   * and the difference is the whole point: a `/v2` write is audit-logged and
   * attributed to the API token, which is what the judge reads to decide what
   * the AGENT did. A deal the story moved would arrive in that log as the
   * agent's own work.
   */
  async function injectInto(request: Record<string, unknown>, ctx: InjectContext) {
    try {
      return await http.post<InjectResult>("/api/sandbox/inject", {
        ...request,
        atISO: ctx.atISO,
      });
    } catch (err) {
      if (err instanceof TwinHttpError && err.status === 404) {
        throw new Error(
          "The attio twin has no POST /api/sandbox/inject route. Scripted beats need it: a " +
            "/v2 write is audit-logged and attributed to the API token, so the world's own " +
            "moves would be scored as the agent's.",
        );
      }
      throw err;
    }
  }

  return {
    name: "attio",
    baseUrl,

    health(): Promise<TwinHealth> {
      return healthViaApi(http, "attio");
    },

    async snapshot(): Promise<TwinSnapshot> {
      // Members first: both the records (a deal's owner) and the tasks (their
      // assignees) render actor references through the same map.
      const members = await captureMembers();
      return {
        twin: "attio",
        capturedAt: Date.now(),
        records: await captureRecords(members),
        notes: await captureNotes(),
        tasks: await captureTasks(members),
      };
    },

    diff(before: TwinSnapshot, after: TwinSnapshot): TwinDiff {
      return diffAttio(before as AttioSnapshot, after as AttioSnapshot);
    },

    renderDiff(diff: TwinDiff): string {
      return renderAttioDiff(diff as AttioDiff);
    },

    async inject(body: BeatBody, ctx: InjectContext): Promise<InjectedRef> {
      const beat = asAttioBeat(body);

      if (beat.kind === "record") {
        const p = beat.payload;
        const res = await injectInto(
          { records: [{ object: p.object, values: p.values }] },
          ctx,
        );
        const made = res.records?.[0];
        if (!made) throw new Error(`attio inject created no ${p.object} record`);
        // The object rides in `containerId` because it is the other half of a
        // record's address — `/v2/objects/{object}/records/{recordId}` — so a
        // later beat that resolves this ref can address it without repeating
        // itself about which object the story put it in.
        return { twin: "attio", id: made.id, containerId: made.object };
      }

      if (beat.kind === "update") {
        const p = beat.payload;
        const target = recordTarget(ctx, p.recordRef, p.object);
        await injectInto(
          { updates: [{ object: target.object, recordId: target.recordId, values: p.values }] },
          ctx,
        );
        return { twin: "attio", id: target.recordId, containerId: target.object };
      }

      if (beat.kind === "note") {
        const p = beat.payload;
        const parent = recordTarget(ctx, p.parentRecordRef, p.parentObject);
        const res = await injectInto(
          {
            notes: [
              {
                parentObject: parent.object,
                parentRecordId: parent.recordId,
                title: p.title,
                content: p.content,
                ...(p.format ? { format: p.format } : {}),
              },
            ],
          },
          ctx,
        );
        const made = res.notes?.[0];
        if (!made) throw new Error(`attio inject created no note on ${p.parentRecordRef}`);
        // A note has no life apart from the record it hangs on, so the record is
        // its container — which is also what a later beat needs to write again.
        return { twin: "attio", id: made.id, containerId: parent.recordId };
      }

      const p = beat.payload;
      const res = await injectInto(
        {
          tasks: [
            {
              content: p.content,
              deadlineAt: p.deadlineISO ?? null,
              linkedRecords: (p.linkedRecords ?? []).map((link) => {
                const target = recordTarget(ctx, link.recordRef, link.object);
                return { object: target.object, recordId: target.recordId };
              }),
              assigneeEmail: p.assignee ? emailOf(ctx.world, p.assignee) : null,
            },
          ],
        },
        ctx,
      );
      const made = res.tasks?.[0];
      if (!made) throw new Error(`attio inject created no task "${p.content}"`);
      // No container: a task belongs to the workspace, and the records it points
      // at are links rather than a home.
      return { twin: "attio", id: made.id };
    },

    seed(spec: EpisodeSpec): Promise<void> {
      return seedAttio(http, spec);
    },

    reset(): Promise<void> {
      return resetViaApi(http, "episode reset");
    },

    auditSince(sinceId: number): Promise<TwinAuditRow[]> {
      return auditViaActivity(http, "attio", sinceId, { sinceId, limit: 1000 });
    },

    projectTrace(trace: AgentTrace): JudgeStep[] {
      return projectTwinTrace(trace, "attio");
    },
  };
}

/**
 * The record a beat is pointing at.
 *
 * Two things can be named here and both are legitimate: what an earlier beat
 * created, which the engine has a handle for, and an account the world was
 * seeded with, which no beat minted and which a spec therefore names by its
 * record id. An unresolvable ref falls through to the twin, whose 400 names the
 * id it could not find — louder and more accurate than anything invented here.
 */
function recordTarget(
  ctx: InjectContext,
  ref: string,
  object: string,
): { recordId: string; object: string } {
  const made = ctx.resolve(ref);
  return { recordId: made?.id ?? ref, object: made?.containerId ?? object };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** Attio's workspace slugs are lowercase and hyphenated; so is its web_url. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
}

/**
 * A stable, UUID-shaped id for a cast member's seat in the workspace.
 *
 * Derived from the `Person.id` rather than generated, because a workspace member
 * id is a thing the agent reads back — off a deal's owner, off a task's assignee
 * — and two runs of the same spec have to produce the same workspace or those
 * ids stop being comparable between runs.
 */
function memberId(personId: string): string {
  const h = createHash("sha1").update(`sonata:attio:member:${personId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * The body `POST /api/sandbox/seed` takes, built here rather than through
 * `shared.ts`'s `seedBodyFor` because this twin's wire shape is its own — a
 * workspace, its members, and the CRM's three objects — and that helper knows
 * only the first three twins.
 *
 * The CRM itself is seeded EMPTY, which is the same deal the other twins get:
 * this loads the cast, as the workspace members a deal can be owned by and a
 * task assigned to, and the accounts an episode needs arrive as beats. Inventing
 * a pipeline from an `EpisodeSpec`, which carries no CRM history, would mean
 * inventing a different one per run.
 */
export function attioSeedBody(spec: EpisodeSpec): Record<string, unknown> {
  const world = spec.world;
  const me = owner(world);
  return {
    twin: "attio",
    seed: {
      world,
      nowISO: new Date(Date.parse(spec.clock.startISO) || Date.now()).toISOString(),
      promoteToSnapshot: true,
      ownerEmail: me.email,
      workspace: { name: world.business.name, slug: slugify(world.business.name) },
      // The twin checks every member against `world.cast`, so a seed built from
      // another world is a 400 here rather than a CRM quietly holding different
      // people from the inbox.
      members: world.cast.map((p) => ({
        id: memberId(p.id),
        email: p.email,
        accessLevel: p.id === me.id ? "admin" : "member",
      })),
      companies: [],
      people: [],
      deals: [],
      notes: [],
      tasks: [],
    },
  };
}

async function seedAttio(
  http: ReturnType<typeof createTwinHttp>,
  spec: EpisodeSpec,
): Promise<void> {
  try {
    await http.post("/api/sandbox/seed", attioSeedBody(spec));
  } catch (err) {
    if (err instanceof TwinHttpError && err.status === 404) {
      throw new Error(
        "The attio twin has no POST /api/sandbox/seed route, so the world could not be " +
          "loaded into it. Seed it out of band and run with seedWorld: false.",
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Diff — pure. Keyed by recordId, which survives every write an agent can make:
// a name can be superseded, a stage can move, and the record is still the same
// account. Nothing is ever removed, because the twin refuses record deletion —
// which is why `AttioDiff` has no `removed` arm to fill.
// ---------------------------------------------------------------------------

const byObjectTitle = byKey<{ object: string; title: string }>((r) => `${r.object} ${r.title}`);

export function diffAttio(before: AttioSnapshot, after: AttioSnapshot): AttioDiff {
  const beforeById = new Map(before.records.map((r) => [r.recordId, r]));

  const created: AttioDiff["created"] = [];
  const valuesChanged: AttioDiff["valuesChanged"] = [];
  let unchangedCount = 0;

  for (const record of after.records) {
    const prev = beforeById.get(record.recordId);
    if (!prev) {
      created.push({ recordId: record.recordId, object: record.object, title: record.title });
      continue;
    }

    // Over the union of both sides, so an attribute that only appears after the
    // agent wrote it is reported as a change from nothing rather than skipped.
    const attributes = new Set([...Object.keys(prev.values), ...Object.keys(record.values)]);
    let touched = false;
    for (const attribute of [...attributes].sort()) {
      const from = prev.values[attribute] ?? "";
      const to = record.values[attribute] ?? "";
      if (from === to) continue;
      valuesChanged.push({
        recordId: record.recordId,
        object: record.object,
        title: record.title,
        attribute,
        from,
        to,
      });
      touched = true;
    }

    // Counted, never listed — the same discipline the mailbox diff follows. A
    // CRM is overwhelmingly untouched by any one day's work, and the count still
    // answers the question that matters: how much did it leave alone?
    if (!touched) unchangedCount++;
  }

  // The record a note hangs on, by name. Read off the same snapshot the note
  // came from, so a note logged against an account the agent otherwise left
  // alone still says which account — the diff itself cannot answer that, and the
  // ordinary beat on this surface is exactly "a note logged against a record".
  const titles = new Map(after.records.map((r) => [r.recordId, r.title]));

  const beforeNotes = new Set(before.notes.map((n) => n.noteId));
  const notesAdded = after.notes
    .filter((n) => !beforeNotes.has(n.noteId))
    .map((n) => ({
      noteId: n.noteId,
      parentObject: n.parentObject,
      parentRecordId: n.parentRecordId,
      // The id is the fallback and not the answer: a record past
      // MAX_RECORDS_PER_OBJECT is not in the capture to be named.
      parentTitle: titles.get(n.parentRecordId) ?? n.parentRecordId,
      title: n.title,
      excerpt: n.excerpt,
    }));

  const beforeTasks = new Map(before.tasks.map((t) => [t.taskId, t]));
  const tasksAdded: AttioDiff["tasksAdded"] = [];
  const tasksCompleted: AttioDiff["tasksCompleted"] = [];
  for (const task of after.tasks) {
    const prev = beforeTasks.get(task.taskId);
    if (!prev) {
      tasksAdded.push({
        taskId: task.taskId,
        content: task.content,
        ...(task.deadlineISO ? { deadlineISO: task.deadlineISO } : {}),
        // Already emails by the time they reach the snapshot, so "who the
        // follow-up landed on" is checkable against the diff and not only
        // against the end state.
        assignees: task.assignees,
      });
      continue;
    }
    // Only a flip counts. A task that arrived already finished was never open,
    // and reporting it as completed would credit the agent with closing it.
    if (!prev.isCompleted && task.isCompleted) {
      tasksCompleted.push({ taskId: task.taskId, content: task.content });
    }
  }

  return {
    twin: "attio",
    created: created.sort(byObjectTitle),
    valuesChanged: valuesChanged.sort(byKey((v) => `${v.object} ${v.title} ${v.attribute}`)),
    notesAdded: notesAdded.sort(byKey((n) => `${n.title} ${n.noteId}`)),
    tasksAdded: tasksAdded.sort(byKey((t) => t.content)),
    tasksCompleted: tasksCompleted.sort(byKey((t) => t.content)),
    unchangedCount,
  };
}

export function renderAttioDiff(diff: AttioDiff): string {
  const lines: string[] = [];
  for (const r of diff.created) {
    lines.push(`+ created ${SINGULAR[r.object] ?? r.object} "${r.title}"`);
  }
  for (const v of diff.valuesChanged) {
    lines.push(
      v.from
        ? `~ "${v.title}" ${v.attribute}: ${v.from} → ${v.to}`
        : `~ "${v.title}" ${v.attribute} set to ${v.to}`,
    );
  }
  for (const n of diff.notesAdded) {
    lines.push(`+ note "${n.title}" on "${n.parentTitle}": ${n.excerpt}`);
  }
  for (const t of diff.tasksAdded) {
    const due = t.deadlineISO ? ` due ${t.deadlineISO}` : " with no deadline";
    // A task nobody is on is a finding rather than a blank, so it is said.
    const who = t.assignees.length ? ` for ${t.assignees.join(", ")}` : " assigned to nobody";
    lines.push(`+ task "${t.content}"${who}${due}`);
  }
  for (const t of diff.tasksCompleted) lines.push(`~ completed task "${t.content}"`);
  lines.push(`${diff.unchangedCount} record(s) untouched`);
  return lines.join("\n");
}
