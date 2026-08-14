import { API_CLIENT_ID, API_SCOPE } from "./auth";

// The fidelity linchpin: SQLite rows in, Attio resources out.
//
// The rule the whole clone rests on is that the typed columns are the source of
// truth for anything the API can filter or mutate on, `extra_json` carries only
// the type parts no filter reaches, and the fields Attio infers on READ —
// email_domain, email_root_domain, email_local_specifier, root_domain — are
// computed here and never stored, because a stored copy would drift from
// text_value the first time a value is superseded.

// --- rows, exactly as SQLite returns them ------------------------------------

export interface ObjectRow {
  id: string;
  api_slug: string;
  singular_noun: string;
  created_at_ms: number;
  pos: number;
}

export interface AttributeRow {
  id: string;
  object_id: string;
  api_slug: string;
  title: string;
  type: string;
  is_multiselect: number;
  currency_code: string | null;
  pos: number;
  created_at_ms: number;
}

export interface StatusRow {
  id: string;
  attribute_id: string;
  title: string;
  is_archived: number;
  celebration_enabled: number;
  target_time_in_status: string | null;
  pos: number;
}

export interface RecordRow {
  id: string;
  object_id: string;
  created_at_ms: number;
}

export interface AttributeValueRow {
  id: number;
  record_id: string;
  attribute_id: string;
  active_from_ms: number;
  active_until_ms: number | null;
  actor_type: string;
  actor_id: string | null;
  text_value: string | null;
  number_value: number | null;
  ref_object: string | null;
  ref_record_id: string | null;
  status_id: string | null;
  extra_json: string | null;
  pos: number;
}

export interface MemberRow {
  id: string;
  first_name: string;
  last_name: string;
  email_address: string;
  access_level: string;
  avatar_url: string | null;
  created_at_ms: number;
}

export interface NoteRow {
  id: string;
  parent_object: string;
  parent_record_id: string;
  title: string;
  content_plaintext: string;
  content_markdown: string;
  created_by_actor_type: string;
  created_by_actor_id: string | null;
  created_at_ms: number;
}

export interface TaskRow {
  id: string;
  content_plaintext: string;
  deadline_at: string | null;
  is_completed: number;
  completed_at_ms: number | null;
  created_by_actor_type: string;
  created_by_actor_id: string | null;
  created_at_ms: number;
}

export interface TaskLinkRow {
  task_id: string;
  target_object: string;
  target_record_id: string;
  pos: number;
}

export interface TaskAssigneeRow {
  task_id: string;
  actor_type: string;
  actor_id: string;
  pos: number;
}

/** The workspace identity every id object and every web_url is stamped with. */
export interface ShapeCtx {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  ownerMemberId: string;
}

export interface Actor {
  type: string;
  id: string | null;
}

// --- primitives --------------------------------------------------------------

/**
 * Attio's timestamps carry NINE fractional digits. A plain toISOString() gives
 * three and is visibly not Attio, which is exactly the sort of tell an agent
 * trained on the real API notices.
 */
export function toAttioTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000000Z");
}

export function actorOf(type: string, id: string | null): Actor {
  return { type, id: id ?? null };
}

export function webUrlFor(ctx: ShapeCtx, object: ObjectRow, recordId: string): string {
  return `https://app.attio.com/${ctx.workspaceSlug}/${object.singular_noun}/${recordId}`;
}

/** The registrable part of a hostname — everything Attio calls root_domain. */
export function rootDomainOf(domain: string): string {
  const labels = domain.split(".");
  return labels.length <= 2 ? domain : labels.slice(-2).join(".");
}

// --- values ------------------------------------------------------------------

function parseExtra(row: AttributeValueRow): Record<string, unknown> {
  if (!row.extra_json) return {};
  return JSON.parse(row.extra_json) as Record<string, unknown>;
}

/**
 * One stored value as Attio returns it. Every branch emits the versioning pair
 * and the provenance; the branch itself only adds the type's own fields.
 */
export function shapeValue(
  ctx: ShapeCtx,
  attr: AttributeRow,
  row: AttributeValueRow,
  statusById: Map<string, StatusRow>,
): Record<string, unknown> {
  const base = {
    active_from: toAttioTimestamp(row.active_from_ms),
    active_until: row.active_until_ms === null ? null : toAttioTimestamp(row.active_until_ms),
    created_by_actor: actorOf(row.actor_type, row.actor_id),
    attribute_type: attr.type,
  };
  const text = row.text_value ?? "";

  switch (attr.type) {
    case "text":
      return { ...base, value: row.text_value };

    case "personal-name": {
      const extra = parseExtra(row);
      return {
        ...base,
        first_name: (extra.first_name as string | undefined) ?? "",
        last_name: (extra.last_name as string | undefined) ?? "",
        full_name: text,
      };
    }

    case "email-address": {
      const at = text.lastIndexOf("@");
      const domain = at === -1 ? "" : text.slice(at + 1);
      return {
        ...base,
        original_email_address: text,
        email_address: text,
        email_domain: domain,
        email_root_domain: domain ? rootDomainOf(domain) : "",
        email_local_specifier: at === -1 ? text : text.slice(0, at),
      };
    }

    case "domain":
      return { ...base, domain: text, root_domain: rootDomainOf(text) };

    case "record-reference":
      return { ...base, target_object: row.ref_object, target_record_id: row.ref_record_id };

    case "status": {
      const status = row.status_id ? statusById.get(row.status_id) : undefined;
      return {
        ...base,
        status: status
          ? {
              id: {
                workspace_id: ctx.workspaceId,
                object_id: attr.object_id,
                attribute_id: attr.id,
                status_id: status.id,
              },
              title: status.title,
              is_archived: status.is_archived === 1,
              target_time_in_status: status.target_time_in_status,
              celebration_enabled: status.celebration_enabled === 1,
            }
          : null,
      };
    }

    case "currency":
      // A JSON number, not a formatted string — Attio's spec types it
      // `{"type": "number"}` on the way in and on the way out.
      return { ...base, currency_value: row.number_value, currency_code: attr.currency_code };

    case "actor-reference":
      // The referenced actor rides in the ref_* pair, NOT in actor_type/actor_id
      // — those carry the value's own provenance, and a deal owned by Priya but
      // set by the API token has to be able to say both things at once.
      return {
        ...base,
        referenced_actor_type: row.ref_object,
        referenced_actor_id: row.ref_record_id,
      };

    default:
      // Unreachable while the schema's `type` vocabulary and this switch agree,
      // which the attributes column comment says they must.
      throw new Error(`attribute ${attr.api_slug} has unshapeable type ${attr.type}`);
  }
}

/**
 * A record IS its bag of values. Every key holds an ARRAY even when the
 * attribute is single-value — that is the shape agents index into — and an
 * attribute with no active value is omitted entirely rather than emitted as an
 * empty array, which is how Attio distinguishes "unset" from "set to nothing".
 */
export function shapeRecord(
  ctx: ShapeCtx,
  object: ObjectRow,
  record: RecordRow,
  attrs: AttributeRow[],
  values: AttributeValueRow[],
  statusById: Map<string, StatusRow>,
): Record<string, unknown> {
  const byAttribute = new Map<string, AttributeValueRow[]>();
  for (const row of values) {
    const list = byAttribute.get(row.attribute_id);
    if (list) list.push(row);
    else byAttribute.set(row.attribute_id, [row]);
  }
  // Emitted in the object's own attribute order rather than in the order the
  // rows happen to come back, so a record reads the same way every time.
  const shaped: Record<string, unknown[]> = {};
  for (const attr of attrs) {
    const rows = byAttribute.get(attr.id);
    if (!rows) continue;
    shaped[attr.api_slug] = rows.map((row) => shapeValue(ctx, attr, row, statusById));
  }
  return {
    id: {
      workspace_id: ctx.workspaceId,
      object_id: object.id,
      record_id: record.id,
    },
    created_at: toAttioTimestamp(record.created_at_ms),
    web_url: webUrlFor(ctx, object, record.id),
    values: shaped,
  };
}

export function shapeNote(ctx: ShapeCtx, row: NoteRow): Record<string, unknown> {
  return {
    id: { workspace_id: ctx.workspaceId, note_id: row.id },
    parent_object: row.parent_object,
    parent_record_id: row.parent_record_id,
    title: row.title,
    // Attio marks meeting_id required on a note; this sandbox has no meetings,
    // so it is always null rather than absent.
    meeting_id: null,
    content_plaintext: row.content_plaintext,
    content_markdown: row.content_markdown,
    tags: [],
    created_by_actor: actorOf(row.created_by_actor_type, row.created_by_actor_id),
    created_at: toAttioTimestamp(row.created_at_ms),
  };
}

/**
 * Note the `_id` suffix on linked_records: Attio reads back `target_object_id`
 * where the write form is `target_object`. Copying that asymmetry matters —
 * an agent that echoes a read straight back into a write has to fail the same
 * way it would against the real API.
 */
export function shapeTask(
  ctx: ShapeCtx,
  row: TaskRow,
  links: TaskLinkRow[],
  assignees: TaskAssigneeRow[],
): Record<string, unknown> {
  return {
    id: { workspace_id: ctx.workspaceId, task_id: row.id },
    content_plaintext: row.content_plaintext,
    deadline_at: row.deadline_at,
    is_completed: row.is_completed === 1,
    completed_at: row.completed_at_ms === null ? null : toAttioTimestamp(row.completed_at_ms),
    linked_records: links.map((l) => ({
      target_object_id: l.target_object,
      target_record_id: l.target_record_id,
    })),
    assignees: assignees.map((a) => ({
      referenced_actor_type: a.actor_type,
      referenced_actor_id: a.actor_id,
    })),
    created_by_actor: actorOf(row.created_by_actor_type, row.created_by_actor_id),
    created_at: toAttioTimestamp(row.created_at_ms),
  };
}

export function shapeMember(ctx: ShapeCtx, row: MemberRow): Record<string, unknown> {
  return {
    id: { workspace_id: ctx.workspaceId, workspace_member_id: row.id },
    first_name: row.first_name,
    last_name: row.last_name,
    avatar_url: row.avatar_url,
    email_address: row.email_address,
    created_at: toAttioTimestamp(row.created_at_ms),
    access_level: row.access_level,
  };
}

/**
 * GET /v2/self is the one endpoint in the surface that is NOT wrapped in `data`,
 * and it is OAuth-token-introspection shaped even though this clone only ever
 * takes a static API key: `exp`/`iat`/`sub`/`aud`/`iss` are all required fields,
 * and a client that validates the response rejects it if any is missing. A
 * sandbox key never expires, so `exp` is null.
 */
export function shapeSelf(ctx: ShapeCtx, nowMs: number): Record<string, unknown> {
  return {
    active: true,
    scope: API_SCOPE,
    client_id: API_CLIENT_ID,
    token_type: "Bearer",
    exp: null,
    iat: Math.floor(nowMs / 1000),
    sub: ctx.workspaceId,
    aud: API_CLIENT_ID,
    iss: "attio.com",
    authorized_by_workspace_member_id: ctx.ownerMemberId,
    workspace_id: ctx.workspaceId,
    workspace_name: ctx.workspaceName,
    workspace_slug: ctx.workspaceSlug,
    workspace_logo_url: null,
  };
}
