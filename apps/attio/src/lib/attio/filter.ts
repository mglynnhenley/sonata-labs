import type { Database } from "better-sqlite3";
import { filterError } from "./errors";
import { listAttributes, resolveStatus } from "../store/objects";
import type { AttributeRow } from "./shape";

// Attio's `{filter, sorts}` grammar compiled to SQL over the versioned value
// rows.
//
// Agents copy filter JSON straight out of Attio's docs, so the grammar has to be
// the documented one. And anything the sandbox cannot evaluate is a loud 400
// naming the feature, never a filter quietly dropped: a filter that is ignored
// matches everything, and an agent will believe the answer it gets back.
//
// Only currently-active values are matched. A deal that WAS at "Lead" and is now
// "In Progress" must not come back from {stage: "Lead"} — the superseded row is
// history, not state.

export interface CompiledQuery {
  where: string;
  params: unknown[];
  orderBy: string;
  orderParams: unknown[];
}

interface Fragment {
  sql: string;
  params: unknown[];
}

const OPERATORS = new Set([
  "$eq",
  "$not_empty",
  "$in",
  "$contains",
  "$starts_with",
  "$ends_with",
  "$lt",
  "$lte",
  "$gt",
  "$gte",
]);

/**
 * Every key Attio's query body declares. `filter_view_id` is a SIBLING of
 * `filter` rather than a key inside it, so nothing that walks `filter` can ever
 * see it; anything outside this list is a typo, `filters` for `filter` being the
 * easy one. Either, taken and then ignored, is a query with no WHERE clause —
 * the whole object comes back with a 200 on it.
 */
const QUERY_KEYS = ["filter", "filter_view_id", "sorts", "limit", "offset"];

/** One sentence, used wherever the key turns up — top level or nested. */
const FILTER_VIEW_REFUSAL =
  `Error in filter: filter_view_id is not supported by the sandbox — express the ` +
  `view's conditions as an inline filter instead.`;

/**
 * The column each attribute type is filterable and sortable through. This map is
 * the reason the writer stores into typed columns rather than a JSON blob: the
 * compiler only ever touches columns.
 */
function canonicalColumn(attr: AttributeRow): string {
  switch (attr.type) {
    case "currency":
      return "v.number_value";
    case "record-reference":
    case "actor-reference":
      return "v.ref_record_id";
    case "status":
      return "v.status_id";
    default:
      return "v.text_value";
  }
}

/**
 * The nested one-level form, `{slug: {field: <op or scalar>}}`. Everything here
 * resolves to an expression over a column — email_domain included, which is
 * derived on the fly rather than stored so it can never disagree with the
 * address it came from.
 */
function fieldExpression(attr: AttributeRow, field: string): string | null {
  switch (field) {
    case "value":
      return attr.type === "currency" ? "v.number_value" : "v.text_value";
    case "full_name":
    case "email_address":
    case "domain":
      return "v.text_value";
    case "first_name":
      return "json_extract(v.extra_json, '$.first_name')";
    case "last_name":
      return "json_extract(v.extra_json, '$.last_name')";
    case "email_domain":
      return "substr(v.text_value, instr(v.text_value, '@') + 1)";
    case "currency_value":
      return "v.number_value";
    case "target_object":
      return "v.ref_object";
    case "target_record_id":
    case "referenced_actor_id":
      return "v.ref_record_id";
    case "status":
      return "v.status_id";
    default:
      return null;
  }
}

/** LIKE's wildcards have to be neutralised or a `%` in a name matches anything. */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function scalarFor(attr: AttributeRow, db: Database, expr: string, raw: unknown): unknown {
  // A status filter is written with the human title; the column holds the id.
  if (expr === "v.status_id" && typeof raw === "string") {
    const status = resolveStatus(db, attr.id, raw);
    if (!status) {
      throw filterError(
        `Error in filter: "${raw}" is not a status of attribute "${attr.api_slug}".`,
      );
    }
    return status.id;
  }
  if (raw === null || typeof raw === "boolean") {
    throw filterError(`Error in filter: unsupported value ${JSON.stringify(raw)}.`);
  }
  return raw;
}

function predicate(
  db: Database,
  attr: AttributeRow,
  expr: string,
  op: string,
  raw: unknown,
): Fragment {
  switch (op) {
    case "$eq":
      return { sql: `${expr} = ?`, params: [scalarFor(attr, db, expr, raw)] };
    case "$not_empty":
      // The operand is not decoration. `false` asks for the opposite set, and
      // that set cannot be built here: this fragment lands inside an EXISTS over
      // the record's active value rows, so negating it would find records
      // holding an empty value rather than records holding none. The question is
      // askable — `{"$not": {"<slug>": {"$not_empty": true}}}` wraps the whole
      // EXISTS — so the refusal names that form rather than guessing.
      if (raw !== true) {
        throw filterError(
          `Error in filter: $not_empty takes true, got ${JSON.stringify(raw)} — ask for ` +
            `the records with no value as {"$not": {"${attr.api_slug}": {"$not_empty": true}}}.`,
        );
      }
      return { sql: `${expr} IS NOT NULL AND ${expr} != ''`, params: [] };
    case "$in": {
      if (!Array.isArray(raw) || !raw.length) {
        throw filterError(`Error in filter: $in expects a non-empty array.`);
      }
      const values = raw.map((v) => scalarFor(attr, db, expr, v));
      return { sql: `${expr} IN (${values.map(() => "?").join(", ")})`, params: values };
    }
    case "$contains":
    case "$starts_with":
    case "$ends_with": {
      if (typeof raw !== "string") {
        throw filterError(`Error in filter: ${op} expects a string.`);
      }
      const escaped = likeEscape(raw);
      const pattern =
        op === "$contains"
          ? `%${escaped}%`
          : op === "$starts_with"
            ? `${escaped}%`
            : `%${escaped}`;
      // SQLite's LIKE is case-insensitive for ASCII, which is what Attio's
      // substring operators do too.
      return { sql: `${expr} LIKE ? ESCAPE '\\'`, params: [pattern] };
    }
    case "$lt":
    case "$lte":
    case "$gt":
    case "$gte": {
      const sign = { $lt: "<", $lte: "<=", $gt: ">", $gte: ">=" }[op];
      return { sql: `${expr} ${sign} ?`, params: [scalarFor(attr, db, expr, raw)] };
    }
    default:
      throw filterError(
        `Error in filter: unknown operator "${op}". Supported: ${[...OPERATORS].join(", ")}.`,
      );
  }
}

/** Every attribute leaf is an EXISTS over that attribute's active value rows. */
function existsOver(attr: AttributeRow, inner: Fragment): Fragment {
  return {
    sql:
      `EXISTS (SELECT 1 FROM attribute_values v ` +
      `WHERE v.record_id = r.id AND v.attribute_id = ? AND v.active_until_ms IS NULL ` +
      `AND (${inner.sql}))`,
    params: [attr.id, ...inner.params],
  };
}

function conjoin(fragments: Fragment[], joiner: "AND" | "OR"): Fragment {
  return {
    sql: fragments.map((f) => `(${f.sql})`).join(` ${joiner} `),
    params: fragments.flatMap((f) => f.params),
  };
}

/** `created_at` hits the record row rather than a value row, so it has its own leaf. */
function createdAtLeaf(raw: unknown): Fragment {
  const bounds = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const parts: Fragment[] = [];
  for (const [op, value] of Object.entries(bounds)) {
    const sign = { $lt: "<", $lte: "<=", $gt: ">", $gte: ">=", $eq: "=" }[op];
    if (!sign) {
      throw filterError(`Error in filter: created_at does not support "${op}".`);
    }
    const ms = Date.parse(String(value));
    if (Number.isNaN(ms)) {
      throw filterError(`Error in filter: created_at bound "${String(value)}" is not a date.`);
    }
    parts.push({ sql: `r.created_at_ms ${sign} ?`, params: [ms] });
  }
  if (!parts.length) {
    throw filterError(`Error in filter: created_at needs at least one bound.`);
  }
  return conjoin(parts, "AND");
}

/**
 * The other record-row leaf. Attio's filtering guide documents `record_id` with
 * both `$eq` and `$in`, and `$in` is how a client re-fetches a set of records it
 * already holds ids for instead of issuing one GET each — a filter agents copy
 * verbatim, and without this leaf it comes back as `unknown attribute
 * "record_id"` listing every attribute except the one the docs promised.
 */
function recordIdLeaf(raw: unknown): Fragment {
  // Ids are opaque strings; a number or a null here is a client bug worth
  // naming, not something to coerce into a WHERE that silently matches nothing.
  const asId = (value: unknown): string => {
    if (typeof value !== "string") {
      throw filterError(
        `Error in filter: record_id takes a record id string, got ${JSON.stringify(value)}.`,
      );
    }
    return value;
  };
  if (typeof raw !== "object" || raw === null) return { sql: `r.id = ?`, params: [asId(raw)] };
  if (Array.isArray(raw)) {
    throw filterError(`Error in filter: record_id takes a string or an object — use $in.`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length) throw filterError(`Error in filter: record_id is empty.`);
  return conjoin(
    entries.map(([op, value]) => {
      if (op === "$eq") return { sql: `r.id = ?`, params: [asId(value)] };
      if (op === "$in") {
        if (!Array.isArray(value) || !value.length) {
          throw filterError(`Error in filter: $in expects a non-empty array.`);
        }
        const ids = value.map(asId);
        return { sql: `r.id IN (${ids.map(() => "?").join(", ")})`, params: ids };
      }
      throw filterError(`Error in filter: record_id supports $eq and $in, not "${op}".`);
    }),
    "AND",
  );
}

function compileNode(
  db: Database,
  attrs: Map<string, AttributeRow>,
  node: unknown,
  path: string,
): Fragment {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw filterError(`Error in filter: ${path} must be an object.`);
  }
  const entries = Object.entries(node as Record<string, unknown>);
  if (!entries.length) throw filterError(`Error in filter: ${path} is empty.`);

  const fragments: Fragment[] = entries.map(([key, value]) => {
    if (key === "$and" || key === "$or") {
      if (!Array.isArray(value) || !value.length) {
        throw filterError(`Error in filter: ${key} expects a non-empty array.`);
      }
      return conjoin(
        value.map((child, i) => compileNode(db, attrs, child, `${path}.${key}[${i}]`)),
        key === "$and" ? "AND" : "OR",
      );
    }
    if (key === "$not") {
      const inner = compileNode(db, attrs, value, `${path}.$not`);
      return { sql: `NOT (${inner.sql})`, params: inner.params };
    }
    // compileQuery refuses the spec's top-level spelling; this catches the one
    // clients nest by mistake, because naming the feature beats answering
    // "unknown attribute filter_view_id".
    if (key === "filter_view_id") throw filterError(FILTER_VIEW_REFUSAL);
    if (key === "path" || key === "constraints") {
      throw filterError(
        `Error in filter: path/constraints filters are not supported by the sandbox — ` +
          `filter on the record's own attributes instead.`,
      );
    }
    if (key === "created_at") return createdAtLeaf(value);
    if (key === "record_id") return recordIdLeaf(value);

    const attr = attrs.get(key);
    if (!attr) {
      throw filterError(
        `Error in filter: unknown attribute "${key}". Known: ` +
          `${[...attrs.keys()].join(", ")}.`,
      );
    }

    // Shorthand: a bare scalar is $eq against the attribute's canonical column.
    if (typeof value !== "object" || value === null) {
      const column = canonicalColumn(attr);
      return existsOver(attr, predicate(db, attr, column, "$eq", value));
    }
    if (Array.isArray(value)) {
      throw filterError(
        `Error in filter: "${key}" takes a scalar or an object, not an array — use $in.`,
      );
    }

    const inner = Object.entries(value as Record<string, unknown>);
    if (!inner.length) throw filterError(`Error in filter: "${key}" is empty.`);

    const parts: Fragment[] = inner.map(([innerKey, innerValue]) => {
      if (OPERATORS.has(innerKey)) {
        return predicate(db, attr, canonicalColumn(attr), innerKey, innerValue);
      }
      if (innerKey.startsWith("$")) {
        throw filterError(
          `Error in filter: unknown operator "${innerKey}". Supported: ` +
            `${[...OPERATORS].join(", ")}.`,
        );
      }
      const expr = fieldExpression(attr, innerKey);
      if (!expr) {
        throw filterError(
          `Error in filter: attribute "${key}" has no filterable field "${innerKey}".`,
        );
      }
      // The nested field can itself carry operators, or be a bare scalar.
      if (typeof innerValue !== "object" || innerValue === null) {
        return predicate(db, attr, expr, "$eq", innerValue);
      }
      if (Array.isArray(innerValue)) {
        throw filterError(`Error in filter: "${key}.${innerKey}" must be a scalar or object.`);
      }
      const ops = Object.entries(innerValue as Record<string, unknown>);
      if (!ops.length) throw filterError(`Error in filter: "${key}.${innerKey}" is empty.`);
      return conjoin(
        ops.map(([op, operand]) => predicate(db, attr, expr, op, operand)),
        "AND",
      );
    });

    return existsOver(attr, conjoin(parts, "AND"));
  });

  return conjoin(fragments, "AND");
}

interface SortSpec {
  attribute?: unknown;
  field?: unknown;
  direction?: unknown;
  path?: unknown;
}

/**
 * Each sort is a correlated scalar subquery over the same canonical column the
 * filter uses, so a record with no value sorts last in both directions rather
 * than jumping to the top on DESC the way a bare NULL would.
 */
function compileSorts(
  db: Database,
  attrs: Map<string, AttributeRow>,
  raw: unknown,
): { orderBy: string; orderParams: unknown[] } {
  if (raw === undefined || raw === null) return defaultOrder();
  if (!Array.isArray(raw)) throw filterError(`Error in filter: sorts must be an array.`);
  if (!raw.length) return defaultOrder();

  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const entry of raw as SortSpec[]) {
    if (typeof entry !== "object" || entry === null) {
      throw filterError(`Error in filter: each sort must be an object.`);
    }
    if (entry.path !== undefined) {
      throw filterError(
        `Error in filter: path-based sorts are not supported by the sandbox — sort on ` +
          `one of the object's own attributes.`,
      );
    }
    const direction = entry.direction === undefined ? "asc" : entry.direction;
    if (direction !== "asc" && direction !== "desc") {
      throw filterError(
        `Error in filter: sort direction must be "asc" or "desc", got ` +
          `${JSON.stringify(direction)}.`,
      );
    }
    const dir = direction === "asc" ? "ASC" : "DESC";
    const attribute = entry.attribute;
    if (typeof attribute !== "string") {
      throw filterError(`Error in filter: each sort needs an "attribute".`);
    }
    if (attribute === "created_at") {
      clauses.push(`r.created_at_ms ${dir}`);
      continue;
    }
    const attr = attrs.get(attribute);
    if (!attr) {
      throw filterError(
        `Error in filter: unknown sort attribute "${attribute}". Known: ` +
          `${[...attrs.keys()].join(", ")}.`,
      );
    }
    let expr = canonicalColumn(attr);
    if (entry.field !== undefined) {
      if (typeof entry.field !== "string") {
        throw filterError(`Error in filter: sort "field" must be a string.`);
      }
      const mapped = fieldExpression(attr, entry.field);
      if (!mapped) {
        throw filterError(
          `Error in filter: attribute "${attribute}" has no sortable field ` +
            `"${entry.field}".`,
        );
      }
      expr = mapped;
    }
    // A status sorts on its option order, not on the opaque id.
    const select =
      attr.type === "status" && expr === "v.status_id"
        ? `(SELECT s.pos FROM attribute_values v JOIN statuses s ON s.id = v.status_id
             WHERE v.record_id = r.id AND v.attribute_id = ? AND v.active_until_ms IS NULL
             ORDER BY v.pos, v.id LIMIT 1)`
        : `(SELECT ${expr} FROM attribute_values v
             WHERE v.record_id = r.id AND v.attribute_id = ? AND v.active_until_ms IS NULL
             ORDER BY v.pos, v.id LIMIT 1)`;
    clauses.push(`${select} IS NULL ASC`, `${select} ${dir}`);
    params.push(attr.id, attr.id);
  }
  clauses.push("r.id ASC");
  return { orderBy: clauses.join(", "), orderParams: params };
}

/** Deterministic, and it is what Attio does when `sorts` is absent. */
function defaultOrder(): { orderBy: string; orderParams: unknown[] } {
  return { orderBy: "r.created_at_ms ASC, r.id ASC", orderParams: [] };
}

export function compileQuery(
  db: Database,
  objectId: string,
  body: Record<string, unknown>,
): CompiledQuery {
  // The body is vetted before a single fragment is compiled, because the keys
  // that would otherwise be dropped are dropped SILENTLY: a `filter_view_id`
  // sitting beside `filter` never reaches compileNode at all, and neither does a
  // misspelled `filters`. Both would answer the whole object with a 200 on it.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw filterError(`Error in filter: the query body must be an object.`);
  }
  for (const key of Object.keys(body)) {
    if (!QUERY_KEYS.includes(key)) {
      throw filterError(
        `Error in filter: unknown query key "${key}". The body takes ` +
          `${QUERY_KEYS.join(", ")}.`,
      );
    }
  }
  if (body.filter_view_id !== undefined) throw filterError(FILTER_VIEW_REFUSAL);

  const attrs = new Map(listAttributes(db, objectId).map((a) => [a.api_slug, a]));
  const { orderBy, orderParams } = compileSorts(db, attrs, body.sorts);
  if (body.filter === undefined || body.filter === null) {
    return { where: "", params: [], orderBy, orderParams };
  }
  const compiled = compileNode(db, attrs, body.filter, "filter");
  return { where: compiled.sql, params: compiled.params, orderBy, orderParams };
}
