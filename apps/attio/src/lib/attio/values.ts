import type { Database, Statement } from "better-sqlite3";
import { badRequestError, valueNotFoundError } from "./errors";
import type { Actor, AttributeRow } from "./shape";
import {
  getAttribute,
  getObjectBySlug,
  listStatuses,
  resolveStatus,
} from "../store/objects";
import { getMemberByEmail, getMemberById } from "../store/members";
import { findRecordByValue, getRecordRow } from "../store/records";

// The write path, and the other half of the fidelity story.
//
// Attio accepts several syntaxes for the same value and normalises them all, so
// the sandbox has to accept the same ones — an agent copying a write straight
// out of the docs must not get a 400 the real API would never give it.
//
// And the rule the whole clone exists to demonstrate: a value is NEVER updated
// in place. The current row is closed (`active_until_ms` set to now) and a new
// row is opened at the same instant, because that pair is exactly what
// `active_from`/`active_until` mean on the way out. Superseding rather than
// overwriting is why "what stage was this deal on last Tuesday" is answerable.
//
// Everything here is synchronous on purpose: better-sqlite3 transactions are,
// and an `await` inside db.transaction(...) silently escapes it.

export interface ParsedValue {
  textValue: string | null;
  numberValue: number | null;
  refObject: string | null;
  refRecordId: string | null;
  statusId: string | null;
  extra: Record<string, unknown> | null;
  /** The canonical dedup key for a multiselect append. */
  key: string;
  /** The human-readable form the audit summary interpolates. */
  display: string;
}

function asList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  return [raw];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A scalar, `{value: …}` or `{<field>: …}` all collapse to one string. */
function stringFrom(raw: unknown, fields: string[], attr: AttributeRow): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  if (isRecord(raw)) {
    for (const field of fields) {
      const value = raw[field];
      if (typeof value === "string") return value;
      if (typeof value === "number") return String(value);
    }
  }
  throw badRequestError(
    `Value for attribute "${attr.api_slug}" must be a string or an object with ` +
      `${fields.map((f) => `"${f}"`).join(" or ")}, got ${JSON.stringify(raw)}.`,
  );
}

function textValue(text: string): ParsedValue {
  return {
    textValue: text,
    numberValue: null,
    refObject: null,
    refRecordId: null,
    statusId: null,
    extra: null,
    key: text.toLowerCase(),
    display: text,
  };
}

/**
 * Attio's personal-name shorthand is `"Last, First"` — and a string with no
 * comma is taken as the FIRST name, not the last, which is easy to get backwards.
 */
function parsePersonalName(raw: unknown, attr: AttributeRow): ParsedValue {
  let first = "";
  let last = "";
  let full = "";
  if (typeof raw === "string") {
    const comma = raw.indexOf(",");
    if (comma === -1) {
      first = raw.trim();
      full = first;
    } else {
      last = raw.slice(0, comma).trim();
      first = raw.slice(comma + 1).trim();
      full = `${first} ${last}`.trim();
    }
  } else if (isRecord(raw)) {
    first = typeof raw.first_name === "string" ? raw.first_name : "";
    last = typeof raw.last_name === "string" ? raw.last_name : "";
    full = typeof raw.full_name === "string" ? raw.full_name : `${first} ${last}`.trim();
  } else {
    throw badRequestError(
      `Value for attribute "${attr.api_slug}" must be "Last, First" or an object with ` +
        `first_name/last_name/full_name, got ${JSON.stringify(raw)}.`,
    );
  }
  return {
    textValue: full,
    numberValue: null,
    refObject: null,
    refRecordId: null,
    statusId: null,
    // first/last live in extra_json because nothing filterable reaches them
    // through a column, and full_name is what every read and sort uses.
    extra: { first_name: first, last_name: last },
    key: full.toLowerCase(),
    display: full,
  };
}

/**
 * A record reference is `{target_object, target_record_id}`, or the shorthand
 * Attio infers from the string itself: an email address means a person, a
 * hostname means a company. That inference is the vendor's, not ours, which is
 * why the two standard objects are named here rather than configured.
 */
function parseRecordReference(db: Database, raw: unknown, attr: AttributeRow): ParsedValue {
  let targetObject: string;
  let targetRecordId: string;

  if (isRecord(raw)) {
    const object = raw.target_object;
    const recordId = raw.target_record_id;
    if (typeof object !== "string" || typeof recordId !== "string") {
      throw badRequestError(
        `Value for attribute "${attr.api_slug}" must carry target_object and ` +
          `target_record_id, got ${JSON.stringify(raw)}.`,
      );
    }
    const obj = getObjectBySlug(db, object);
    if (!obj) throw valueNotFoundError(`Object with slug/ID "${object}" not found.`);
    if (!getRecordRow(db, obj.id, recordId)) {
      throw valueNotFoundError(`Record with ID "${recordId}" not found.`);
    }
    targetObject = obj.api_slug;
    targetRecordId = recordId;
  } else if (typeof raw === "string") {
    const isEmail = raw.includes("@");
    const slug = isEmail ? "people" : "companies";
    const obj = getObjectBySlug(db, slug);
    const found = obj
      ? findRecordByValue(db, obj.id, isEmail ? "email_addresses" : "domains", raw)
      : null;
    if (!found) {
      throw valueNotFoundError(
        `Could not find a ${slug} record matching "${raw}" — reference it by ` +
          `{target_object, target_record_id} or create the record first.`,
      );
    }
    targetObject = slug;
    targetRecordId = found.id;
  } else {
    throw badRequestError(
      `Value for attribute "${attr.api_slug}" must be a reference object or a ` +
        `domain/email shorthand, got ${JSON.stringify(raw)}.`,
    );
  }

  return {
    textValue: null,
    numberValue: null,
    refObject: targetObject,
    refRecordId: targetRecordId,
    statusId: null,
    extra: null,
    key: targetRecordId,
    display: `${targetObject}/${targetRecordId}`,
  };
}

/**
 * Attio errors rather than inventing a status, so the message has to say what IS
 * allowed — a bare "not found" leaves an agent guessing at a closed vocabulary.
 */
function parseStatus(db: Database, raw: unknown, attr: AttributeRow): ParsedValue {
  const titleOrId = stringFrom(raw, ["status", "title"], attr);
  const status = resolveStatus(db, attr.id, titleOrId);
  if (!status) {
    const allowed = listStatuses(db, attr.id).map((s) => `"${s.title}"`).join(", ");
    throw valueNotFoundError(
      `Cannot find select attribute with select option title "${titleOrId}". ` +
        `Allowed values for "${attr.api_slug}": ${allowed}.`,
    );
  }
  return {
    textValue: status.title,
    numberValue: null,
    refObject: null,
    refRecordId: null,
    statusId: status.id,
    extra: null,
    key: status.id,
    display: status.title,
  };
}

/** currency_code is never writable — it is inherited from the attribute. */
function parseCurrency(raw: unknown, attr: AttributeRow): ParsedValue {
  const source = isRecord(raw) ? raw.currency_value : raw;
  const amount = typeof source === "string" ? Number(source) : source;
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw badRequestError(
      `Value for attribute "${attr.api_slug}" must be a number or a numeric string, ` +
        `got ${JSON.stringify(raw)}.`,
    );
  }
  return {
    textValue: null,
    numberValue: amount,
    refObject: null,
    refRecordId: null,
    statusId: null,
    extra: null,
    key: String(amount),
    display: `${amount}${attr.currency_code ? ` ${attr.currency_code}` : ""}`,
  };
}

function parseActorReference(db: Database, raw: unknown, attr: AttributeRow): ParsedValue {
  let member = null;
  if (isRecord(raw) && typeof raw.referenced_actor_id === "string") {
    member = getMemberById(db, raw.referenced_actor_id);
  } else {
    const email = stringFrom(raw, ["workspace_member_email_address", "email_address"], attr);
    member = getMemberByEmail(db, email);
  }
  if (!member) {
    throw valueNotFoundError(
      `Value for attribute "${attr.api_slug}" names no workspace member ` +
        `(${JSON.stringify(raw)}) — list GET /v2/workspace_members to find one.`,
    );
  }
  return {
    textValue: null,
    numberValue: null,
    // The referenced actor rides in the ref_* pair so actor_type/actor_id stay
    // free to say who WROTE the value.
    refObject: "workspace-member",
    refRecordId: member.id,
    statusId: null,
    extra: null,
    key: member.id,
    display: `${member.first_name} ${member.last_name}`.trim(),
  };
}

/** One wire value (or array of them) normalised to the stored tuple. */
export function parseWriteValue(
  db: Database,
  attr: AttributeRow,
  raw: unknown,
): ParsedValue[] {
  const entries = asList(raw);
  if (!entries.length || entries.every((e) => e === null || e === undefined)) {
    throw badRequestError(
      `Attribute "${attr.api_slug}" was given no value. Clearing a value is not ` +
        `implemented in the sandbox.`,
    );
  }
  if (entries.length > 1 && attr.is_multiselect !== 1) {
    throw badRequestError(
      `Attribute "${attr.api_slug}" accepts a single value but ${entries.length} were ` +
        `supplied.`,
    );
  }

  return entries.map((entry) => {
    switch (attr.type) {
      case "text":
        return textValue(stringFrom(entry, ["value"], attr));
      case "personal-name":
        return parsePersonalName(entry, attr);
      case "email-address":
        return textValue(stringFrom(entry, ["email_address", "value"], attr));
      case "domain":
        return textValue(stringFrom(entry, ["domain", "value"], attr));
      case "record-reference":
        return parseRecordReference(db, entry, attr);
      case "status":
        return parseStatus(db, entry, attr);
      case "currency":
        return parseCurrency(entry, attr);
      case "actor-reference":
        return parseActorReference(db, entry, attr);
      default:
        // Unreachable while the schema's `type` vocabulary and this switch agree.
        throw badRequestError(
          `Attribute "${attr.api_slug}" has type "${attr.type}", which the sandbox ` +
            `cannot write.`,
        );
    }
  });
}

export interface ValueChange {
  slug: string;
  title: string;
  before: string | null;
  after: string;
}

export interface WriteTarget {
  recordId: string;
  objectId: string;
  objectSlug: string;
}

export interface WriteOptions {
  atMs: number;
  actor: Actor;
  /**
   * `create` writes a fresh record's whole bag. `append` is PATCH: single-value
   * attributes supersede, multiselect attributes gain the new values and keep
   * the old — Attio's documented difference between PATCH and PUT.
   */
  mode: "create" | "append";
  isSandboxCreated: boolean;
}

const INSERT_VALUE = `INSERT INTO attribute_values
  (record_id, attribute_id, active_from_ms, active_until_ms, actor_type, actor_id,
   text_value, number_value, ref_object, ref_record_id, status_id, extra_json,
   is_sandbox_created, pos)
 VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Write a bag of values against one record and report what changed. The
 * ValueChange list is what the audit summary interpolates, so the transition an
 * episode is graded on — `stage: In Progress → Won 🎉` — is generated here
 * rather than hand-written in each route.
 *
 * Call inside a transaction: the supersede and the insert are one change.
 */
export function writeValues(
  db: Database,
  target: WriteTarget,
  values: Record<string, unknown>,
  opts: WriteOptions,
): ValueChange[] {
  const changes: ValueChange[] = [];
  const insert = db.prepare(INSERT_VALUE);

  for (const [slug, raw] of Object.entries(values)) {
    const attr = getAttribute(db, target.objectId, slug);
    if (!attr) {
      throw badRequestError(
        `Cannot find attribute with slug/ID "${slug}" on object "${target.objectSlug}".`,
      );
    }
    const parsed = parseWriteValue(db, attr, raw);

    const active = db
      .prepare(
        `SELECT id, text_value, number_value, ref_record_id, status_id, pos, active_from_ms
           FROM attribute_values
          WHERE record_id = ? AND attribute_id = ? AND active_until_ms IS NULL
          ORDER BY pos, id`,
      )
      .all(target.recordId, attr.id) as Array<{
      id: number;
      text_value: string | null;
      number_value: number | null;
      ref_record_id: string | null;
      status_id: string | null;
      pos: number;
      active_from_ms: number;
    }>;
    const before = active.length ? describeActive(db, attr, active) : null;

    if (attr.is_multiselect === 1 && opts.mode === "append") {
      const existing = new Set(
        active.map((row) => keyOfRow(row).toLowerCase()),
      );
      const added = parsed.filter((value) => {
        if (existing.has(value.key.toLowerCase())) return false;
        existing.add(value.key.toLowerCase());
        return true;
      });
      if (!added.length) continue;
      // Attio prepends the supplied values and the supplied block KEEPS ITS
      // ORDER, so the block is laid out below the current minimum position and
      // counts up from there. Walking one position down per value would have
      // read back reversed — and only when the record already had a value,
      // since the create path below numbers upwards.
      const base = Math.min(0, ...active.map((r) => r.pos)) - added.length;
      added.forEach((value, i) =>
        runInsert(insert, target.recordId, attr, value, opts, base + i),
      );
      changes.push({
        slug: attr.api_slug,
        title: attr.title,
        before,
        after: [...added.map((v) => v.display), ...(before ? [before] : [])].join(", "),
      });
      continue;
    }

    if (opts.mode === "append" && active.length) {
      // A value cannot stop being true before it started. `atMs` is the world's
      // clock, and /api/sandbox/inject lets a director backdate a beat, so this
      // is reachable: closing a row at an instant before its own active_from
      // writes an interval that runs backwards, and shapeValue emits it verbatim
      // for an agent to reason about. Refuse rather than clamp — a zero-length
      // interval would claim the superseded value was never true at all.
      const opened = Math.max(...active.map((r) => r.active_from_ms));
      if (opts.atMs < opened) {
        throw badRequestError(
          `Cannot supersede "${attr.api_slug}" at ${new Date(opts.atMs).toISOString()}: its current value has been active since ${new Date(opened).toISOString()}.`,
        );
      }
      // Supersede: the old row is closed at exactly the instant the new one
      // opens, so the two are contiguous and a reader never sees a gap.
      db.prepare(
        `UPDATE attribute_values SET active_until_ms = ?
          WHERE record_id = ? AND attribute_id = ? AND active_until_ms IS NULL`,
      ).run(opts.atMs, target.recordId, attr.id);
    }
    parsed.forEach((value, i) => runInsert(insert, target.recordId, attr, value, opts, i));
    changes.push({
      slug: attr.api_slug,
      title: attr.title,
      before,
      after: parsed.map((v) => v.display).join(", "),
    });
  }

  return changes;
}

function runInsert(
  stmt: Statement,
  recordId: string,
  attr: AttributeRow,
  value: ParsedValue,
  opts: WriteOptions,
  pos: number,
): void {
  stmt.run(
    recordId,
    attr.id,
    opts.atMs,
    opts.actor.type,
    opts.actor.id,
    value.textValue,
    value.numberValue,
    value.refObject,
    value.refRecordId,
    value.statusId,
    value.extra ? JSON.stringify(value.extra) : null,
    opts.isSandboxCreated ? 1 : 0,
    pos,
  );
}

function keyOfRow(row: {
  text_value: string | null;
  number_value: number | null;
  ref_record_id: string | null;
  status_id: string | null;
}): string {
  return (
    row.status_id ?? row.ref_record_id ?? row.text_value ?? String(row.number_value ?? "")
  );
}

/** The human-readable form of what is currently active, for the audit summary. */
function describeActive(
  db: Database,
  attr: AttributeRow,
  rows: Array<{
    text_value: string | null;
    number_value: number | null;
    ref_record_id: string | null;
    status_id: string | null;
  }>,
): string {
  return rows
    .map((row) => {
      if (attr.type === "status") {
        return row.text_value ?? row.status_id ?? "";
      }
      if (attr.type === "record-reference") return String(row.ref_record_id);
      if (attr.type === "currency") {
        return `${row.number_value}${attr.currency_code ? ` ${attr.currency_code}` : ""}`;
      }
      if (attr.type === "actor-reference") {
        const member = row.ref_record_id ? getMemberById(db, row.ref_record_id) : null;
        return member
          ? `${member.first_name} ${member.last_name}`.trim()
          : String(row.ref_record_id);
      }
      return row.text_value ?? "";
    })
    .join(", ");
}
