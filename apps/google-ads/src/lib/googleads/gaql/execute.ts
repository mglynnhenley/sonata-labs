import type { Database } from "better-sqlite3";
import { queryError } from "../errors";
import { addDays, formatInZone, monthBounds } from "../dates";
import {
  JOINABLE,
  lookupField,
  resourceOf,
  type FieldSpec,
  type ResourceKind,
  type Selectable,
} from "../resources";
import { buildRow, fieldMaskFor, type GoogleAdsRow, type ResourceIds, type SelectedField } from "../shape";
import type { CustomerRow } from "../../store/customers";
import { getWorldNowMs } from "../../store/meta";
import type { Condition, GaqlQuery } from "./parse";

// AST → validated plan → SQL → GoogleAdsRow[].
//
// This is the one place outside src/lib/store that writes SQL, and it earns the
// exception: a report's shape is decided by the query, so it cannot be a fixed
// prepared statement. The safety rule that makes that acceptable is absolute —
// every identifier interpolated into the string comes out of resources.ts, and
// every value the caller supplied is bound.
//
// The query's own LIMIT belongs here, because it is part of the query. Paging
// deliberately does not: the executor returns every row the LIMIT allows and the
// route slices it, which is what lets googleAds:search and googleAds:searchStream
// share this function unchanged even though only one of them paginates.

/** SQL table alias per resource, so the builder never spells a table twice. */
const ALIAS: Record<ResourceKind, string> = {
  customer: "cu",
  campaign: "c",
  campaign_budget: "b",
  ad_group: "ag",
};

const DURING_LITERALS = [
  "TODAY",
  "YESTERDAY",
  "LAST_7_DAYS",
  "LAST_14_DAYS",
  "LAST_30_DAYS",
  "THIS_MONTH",
  "LAST_MONTH",
] as const;

export interface ExecuteResult {
  rows: GoogleAdsRow[];
  fieldMask: string;
  /**
   * How many rows the query matched BEFORE its LIMIT. `totalResultsCount` is
   * defined as the match count "ignoring the LIMIT clause", so it cannot be read
   * off `rows` once the limit has been applied.
   */
  totalCount: number;
}

/**
 * The SQL for one field. A metric is an aggregate over the window; a ratio is
 * derived from two sums in the same expression, which is what keeps it honest
 * after an injected beat rewrites a day — there is no stored ctr to go stale.
 */
function expressionFor(spec: FieldSpec): string {
  if (spec.metric === "sum") return `SUM(ds.${spec.column})`;
  if (spec.gaql === "metrics.ctr") {
    return "(CASE WHEN SUM(ds.impressions) > 0 THEN CAST(SUM(ds.clicks) AS REAL) / SUM(ds.impressions) ELSE 0 END)";
  }
  if (spec.gaql === "metrics.average_cpc") {
    return "(CASE WHEN SUM(ds.clicks) > 0 THEN CAST(SUM(ds.cost_micros) AS REAL) / SUM(ds.clicks) ELSE 0 END)";
  }
  if (spec.gaql === "segments.date") return "ds.date";
  return `${ALIAS[resourceOf(spec.gaql) as ResourceKind]}.${spec.column}`;
}

/** Every field the query mentions anywhere, so joins and grain can be decided. */
function referencedResources(query: GaqlQuery): Set<Selectable> {
  const seen = new Set<Selectable>();
  for (const name of query.select) seen.add(resourceOf(name));
  for (const cond of query.where) seen.add(resourceOf(cond.field));
  for (const key of query.orderBy) seen.add(resourceOf(key.field));
  return seen;
}

/**
 * A field can only be reached from a FROM resource the real API joins it to.
 * `SELECT ad_group.name FROM campaign_budget` is not a missing feature — Google
 * refuses it too, because a budget does not imply one ad group.
 */
function checkReachable(name: string, from: ResourceKind): void {
  const kind = resourceOf(name);
  if (kind === "metrics" || kind === "segments") return;
  if (!JOINABLE[from].includes(kind as ResourceKind)) {
    throw queryError(
      "UNRECOGNIZED_FIELD",
      `Field '${name}' cannot be selected from resource '${from}'.`,
      name,
    );
  }
}

function specOf(name: string): FieldSpec {
  const spec = lookupField(name);
  // parse.ts already refused unknown names, so this cannot fire for a query that
  // came through the parser — it guards a caller that built an AST by hand.
  if (!spec) throw queryError("UNRECOGNIZED_FIELD", `Unrecognized field in the query: '${name}'.`, name);
  return spec;
}

/** Values are checked against the field's own type, not guessed from their text. */
function checkValue(spec: FieldSpec, value: string): void {
  if (spec.type === "enum" && spec.enumValues && !spec.enumValues.includes(value)) {
    throw queryError(
      "BAD_ENUM_CONSTANT",
      `Unrecognized enum value '${value}' for field '${spec.gaql}'.`,
      value,
    );
  }
  if ((spec.type === "int64" || spec.type === "double") && !Number.isFinite(Number(value))) {
    throw queryError("BAD_VALUE", `Field '${spec.gaql}' expects a number, got '${value}'.`, value);
  }
}

/** `today` is the WORLD's date, never the wall clock — see store/meta.ts. */
function duringRange(literal: string, today: string): { start: string; end: string } {
  switch (literal) {
    case "TODAY":
      return { start: today, end: today };
    case "YESTERDAY":
      return { start: addDays(today, -1), end: addDays(today, -1) };
    // Google's own definition: the last N days NOT including today.
    case "LAST_7_DAYS":
      return { start: addDays(today, -7), end: addDays(today, -1) };
    case "LAST_14_DAYS":
      return { start: addDays(today, -14), end: addDays(today, -1) };
    case "LAST_30_DAYS":
      return { start: addDays(today, -30), end: addDays(today, -1) };
    case "THIS_MONTH":
      return monthBounds(today);
    case "LAST_MONTH":
      return monthBounds(addDays(monthBounds(today).start, -1));
    default:
      throw queryError(
        "BAD_ENUM_CONSTANT",
        `Unrecognized date range '${literal}'; this sandbox supports ${DURING_LITERALS.join(", ")}.`,
        literal,
      );
  }
}

interface Predicate {
  sql: string;
  params: unknown[];
}

/**
 * Every operand arrives from the tokenizer as text, and SQLite sorts every
 * integer before every string — so binding "1000000000" against a SUM silently
 * matches nothing rather than erroring. The field's own type decides how its
 * operand crosses into SQL: numbers as numbers, GAQL's TRUE/FALSE as the 0/1 the
 * column actually stores, everything else verbatim.
 *
 * Resource ids are the exception that has to be spelled out: they are int64 on
 * the wire but TEXT in the table — which is the whole reason there is no BigInt
 * anywhere in this clone — so `campaign.id = 17204885331` binds a string.
 */
function bindValue(spec: FieldSpec, value: string): unknown {
  if (spec.type === "int64") return spec.column === "id" ? value : Number(value);
  if (spec.type === "double") return Number(value);
  if (spec.type === "bool") return value.toUpperCase() === "TRUE" ? 1 : 0;
  return value;
}

function compileCondition(cond: Condition, spec: FieldSpec, today: string): Predicate {
  const expr = expressionFor(spec);

  if (cond.op === "DURING") {
    if (spec.gaql !== "segments.date") {
      throw queryError(
        "BAD_OPERATOR",
        `DURING only applies to segments.date, not to '${spec.gaql}'.`,
        cond.op,
      );
    }
    const range = duringRange(cond.values[0].toUpperCase(), today);
    return { sql: `${expr} BETWEEN ? AND ?`, params: [range.start, range.end] };
  }

  for (const value of cond.values) checkValue(spec, value);
  const bound = cond.values.map((value) => bindValue(spec, value));

  switch (cond.op) {
    case "BETWEEN":
      return { sql: `${expr} BETWEEN ? AND ?`, params: [bound[0], bound[1]] };
    case "IN":
      return { sql: `${expr} IN (${bound.map(() => "?").join(", ")})`, params: bound };
    case "NOT IN":
      return { sql: `${expr} NOT IN (${bound.map(() => "?").join(", ")})`, params: bound };
    // The caller's % survives verbatim: GAQL's LIKE is SQL's LIKE.
    case "LIKE":
      return { sql: `${expr} LIKE ?`, params: [cond.values[0]] };
    case "NOT LIKE":
      return { sql: `${expr} NOT LIKE ?`, params: [cond.values[0]] };
    default:
      return { sql: `${expr} ${cond.op} ?`, params: [bound[0]] };
  }
}

/**
 * The tenant predicate for a FROM resource. `customers` is keyed by the id
 * itself; every other table carries a `customer_id`, so the scope never depends
 * on a join being present.
 */
function scopeToCustomer(from: ResourceKind): string {
  return from === "customer" ? `${ALIAS.customer}.id = ?` : `${ALIAS[from]}.customer_id = ?`;
}

/** The joins each FROM resource can carry, added only when something asks for one. */
function buildFrom(from: ResourceKind, referenced: Set<Selectable>, needsStats: boolean): string {
  const parts: string[] = [];
  const wantsBudget = referenced.has("campaign_budget");
  const wantsCustomer = referenced.has("customer");

  if (from === "customer") {
    parts.push("FROM customers cu");
    if (needsStats) parts.push("JOIN daily_stats ds ON ds.customer_id = cu.id");
    return parts.join(" ");
  }

  if (from === "campaign_budget") {
    parts.push("FROM campaign_budgets b");
    if (wantsCustomer) parts.push("JOIN customers cu ON cu.id = b.customer_id");
    if (needsStats) {
      // A budget's metrics are its campaigns' metrics; the bridge is internal and
      // never selectable, which is why it gets its own alias.
      parts.push("JOIN campaigns bc ON bc.budget_id = b.id");
      parts.push("JOIN daily_stats ds ON ds.campaign_id = bc.id");
    }
    return parts.join(" ");
  }

  if (from === "campaign") {
    parts.push("FROM campaigns c");
    if (wantsBudget) parts.push("LEFT JOIN campaign_budgets b ON b.id = c.budget_id");
    if (wantsCustomer) parts.push("JOIN customers cu ON cu.id = c.customer_id");
    if (needsStats) parts.push("JOIN daily_stats ds ON ds.campaign_id = c.id");
    return parts.join(" ");
  }

  parts.push("FROM ad_groups ag");
  if (referenced.has("campaign") || wantsBudget) {
    parts.push("JOIN campaigns c ON c.id = ag.campaign_id");
  }
  if (wantsBudget) parts.push("LEFT JOIN campaign_budgets b ON b.id = c.budget_id");
  if (wantsCustomer) parts.push("JOIN customers cu ON cu.id = ag.customer_id");
  if (needsStats) parts.push("JOIN daily_stats ds ON ds.ad_group_id = ag.id");
  return parts.join(" ");
}

export function executeGaql(db: Database, query: GaqlQuery, customer: CustomerRow): ExecuteResult {
  const from = query.from as ResourceKind;
  const referenced = referencedResources(query);

  for (const name of query.select) checkReachable(name, from);
  for (const cond of query.where) checkReachable(cond.field, from);
  for (const key of query.orderBy) checkReachable(key.field, from);

  const selected: SelectedField[] = query.select.map((name, i) => ({
    spec: specOf(name),
    alias: `a${i}`,
  }));

  // A query that asks for no metric and no date is a plain attribute query: no
  // stats join, no date window, and nothing is dropped for want of spend.
  const needsStats = referenced.has("metrics") || referenced.has("segments");
  // A segment changes the GRAIN only when it is selected. In the WHERE clause it
  // is just a window, exactly as Google treats it.
  const segmented = query.select.includes("segments.date");
  const today = formatInZone(getWorldNowMs(db), customer.time_zone);

  const projections = selected.map((s) => `${expressionFor(s.spec)} AS ${s.alias}`);
  // Every resource in a row carries its resourceName even when unselected, so
  // each one's id has to come back whether the caller asked for it or not. The
  // FROM resource is in that set unconditionally — a metrics-only query mentions
  // it nowhere but `referenced`, and its rows still have to say what they are.
  const idKinds = [...new Set<Selectable>([from, ...referenced])].filter(
    (k): k is ResourceKind => k !== "metrics" && k !== "segments",
  );
  for (const kind of idKinds) projections.push(`${ALIAS[kind]}.id AS __id_${kind}`);

  // Every query is scoped to the customer in the request path, on the FROM
  // resource itself rather than through a join that only exists when the caller
  // happens to select a customer field. A Google Ads account is a tenant
  // boundary: `customers/A/googleAds:search` returning B's campaigns would be
  // the worst kind of wrong answer, because it looks like a correct one.
  const where: string[] = [scopeToCustomer(from)];
  const having: string[] = [];
  const whereParams: unknown[] = [customer.id];
  const havingParams: unknown[] = [];

  for (const cond of query.where) {
    const spec = specOf(cond.field);
    const predicate = compileCondition(cond, spec, today);
    // A metric only exists after aggregation, so it filters the group, not the row.
    if (spec.metric) {
      having.push(predicate.sql);
      havingParams.push(...predicate.params);
    } else {
      where.push(predicate.sql);
      whereParams.push(...predicate.params);
    }
  }

  const baseId = `${ALIAS[from]}.id`;
  const groupBy = needsStats ? [baseId, ...(segmented ? ["ds.date"] : [])] : [];

  const order = query.orderBy.length
    ? query.orderBy.map((key) => `${expressionFor(specOf(key.field))} ${key.desc ? "DESC" : "ASC"}`)
    : [`${baseId} ASC`, ...(segmented ? ["ds.date ASC"] : [])];

  const sql = [
    `SELECT ${projections.join(", ")}`,
    buildFrom(from, referenced, needsStats),
    where.length ? `WHERE ${where.join(" AND ")}` : "",
    groupBy.length ? `GROUP BY ${groupBy.join(", ")}` : "",
    having.length ? `HAVING ${having.join(" AND ")}` : "",
    `ORDER BY ${order.join(", ")}`,
  ]
    .filter(Boolean)
    .join(" ");

  const sqlRows = db.prepare(sql).all(...whereParams, ...havingParams) as Array<
    Record<string, unknown>
  >;
  const rows = sqlRows.map((sqlRow) => {
    const ids: ResourceIds = {};
    for (const kind of idKinds) ids[kind] = (sqlRow[`__id_${kind}`] as string | null) ?? null;
    return buildRow(sqlRow, selected, ids, customer.id, from);
  });

  // LIMIT is applied HERE and not as SQL, because totalResultsCount is defined as
  // the number of rows the query matched ignoring the LIMIT clause — a SELECT
  // that has already clipped itself has no way to report it.
  return {
    rows: query.limit === undefined ? rows : rows.slice(0, query.limit),
    fieldMask: fieldMaskFor(selected),
    totalCount: rows.length,
  };
}
