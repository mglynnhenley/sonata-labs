import {
  containerFor,
  resourceNameFor,
  resourceOf,
  type FieldSpec,
  type ResourceKind,
  type Selectable,
} from "./resources";

// Turning a flat SQL row into a GoogleAdsRow.
//
// The fidelity linchpin is the type coercion, not the nesting. Google speaks
// proto3 JSON, where an int64 crosses the wire as a JSON STRING: `campaign.id`
// is `"17204885331"` and never `17204885331`, and `metrics.cost_micros` is
// `"2884000000"`. Doubles stay numbers. An agent that parseInt()s one and
// Number()s the other is doing the right thing against the real API, and a clone
// that emits raw numbers quietly teaches it the opposite.
//
// The same mapping decides what is NOT in the row. proto3 JSON omits an unset
// field rather than spelling it out, so a NULL column becomes an ABSENT key and
// never a null — Google has no way to send `endDate: null` for a campaign with
// no end date, and an agent branching on `'endDate' in row.campaign` has to get
// the same answer here that it gets there.

export type GoogleAdsRow = Record<string, Record<string, unknown>>;

/** One selected field, bound to the SQL alias its value arrives under. */
export interface SelectedField {
  spec: FieldSpec;
  alias: string;
}

/** The id of each resource present in a row, so every one can carry its name. */
export type ResourceIds = Partial<Record<ResourceKind, string | null>>;

/**
 * A field's own type decides how its value crosses the wire. A resource-name
 * field needs no case here: the executor selects it as its path already, so that
 * a WHERE clause on it compares against the same text — it arrives as the string
 * it will be sent as.
 */
function coerce(spec: FieldSpec, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (spec.type) {
    case "int64":
      // proto3 JSON mapping: 64-bit integers are strings on the wire.
      return String(Math.trunc(Number(value)));
    case "double":
      return Number(value);
    case "bool":
      return Boolean(value);
    default:
      return String(value);
  }
}

/**
 * Build one response row. Every resource object that appears also gets its
 * `resourceName` even when the query did not select it, because the real API
 * always returns it — `metrics` and `segments` get none, they are not resources.
 *
 * The FROM resource is in the row whether or not a single field of it was
 * selected. `SELECT metrics.clicks FROM campaign` is the commonest report an
 * agent writes — spend per campaign with no attributes — and Google always
 * returns the main resource's name for it. Without that, the response is a
 * handful of anonymous numbers with no way to tell which campaign each is.
 */
export function buildRow(
  sqlRow: Record<string, unknown>,
  selected: SelectedField[],
  ids: ResourceIds,
  customerId: string,
  from: ResourceKind,
): GoogleAdsRow {
  const fromContainer = containerFor(from);
  const out: GoogleAdsRow = { [fromContainer]: {} };
  // kind → the JSON container it lands in, for the resourceName pass below. The
  // FROM resource is seeded so that pass reaches it even with nothing selected.
  const touched = new Map<Selectable, string>([[from, fromContainer]]);

  for (const { spec, alias } of selected) {
    const [container, leaf] = spec.json.split(".");
    // Registered before the value is looked at, so a resource whose every
    // selected field is unset still reaches the resourceName pass below.
    touched.set(resourceOf(spec.gaql), container);
    const value = coerce(spec, sqlRow[alias]);
    if (value === null) continue;
    (out[container] ??= {})[leaf] = value;
  }

  for (const [kind, container] of touched) {
    if (kind === "metrics" || kind === "segments") continue;
    const id = ids[kind];
    if (id === undefined || id === null) continue;
    // The container may not exist yet: `SELECT campaign.end_date FROM ad_group`
    // against a campaign with no end date selects nothing that survives, and the
    // resource is still in the row because it is still in the join.
    (out[container] ??= {}).resourceName = resourceNameFor(kind, customerId, id);
  }

  return out;
}

/**
 * The SELECT order, camelCased — clients use it to know which columns arrived.
 * It stays SELECT-only: the auto-returned `resourceName` is deliberately NOT in
 * it, exactly as the real API's fieldMask omits it.
 */
export function fieldMaskFor(selected: SelectedField[]): string {
  return selected.map((s) => s.spec.json).join(",");
}
