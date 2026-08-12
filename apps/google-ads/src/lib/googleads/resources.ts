// The field catalogue — the single source of truth the GAQL parser validates
// against and the shaper reads, so the two can never disagree about what exists.
// Adding a field here is the whole job of adding a field to the API: the parser
// starts accepting it, the executor knows which column it lives in and the
// shaper emits it under the right camelCase path, with no other edit anywhere.
//
// A field that is not in this table is UNRECOGNIZED_FIELD, by construction.

export type FieldType = "int64" | "double" | "string" | "enum" | "date" | "bool";

/** The four real resources. `metrics` and `segments` are pseudo-resources. */
export type ResourceKind = "customer" | "campaign" | "campaign_budget" | "ad_group";
export type Selectable = ResourceKind | "metrics" | "segments";

export interface FieldSpec {
  /** The GAQL spelling, e.g. `campaign_budget.amount_micros`. */
  gaql: string;
  /** The proto3-JSON path the response nests it under, e.g. `campaignBudget.amountMicros`. */
  json: string;
  type: FieldType;
  /** The column on this resource's own table, when the value is stored. */
  column?: string;
  enumValues?: readonly string[];
  /**
   * The value is an id that renders as a resource name rather than as itself —
   * `campaign.campaign_budget` is the attached budget's path, not its number.
   */
  resourceRef?: ResourceKind;
  /**
   * metrics only. `sum` is a plain SUM over the window; `computed` is derived
   * from two sums at read time (see shape.ts) so an injected beat can never
   * leave a stored ratio stale.
   */
  metric?: "sum" | "computed";
}

const CAMPAIGN_STATUSES = ["ENABLED", "PAUSED", "REMOVED"] as const;
const BUDGET_STATUSES = ["ENABLED", "REMOVED"] as const;

const FIELD_LIST: readonly FieldSpec[] = [
  // customer
  { gaql: "customer.id", json: "customer.id", type: "int64", column: "id" },
  { gaql: "customer.resource_name", json: "customer.resourceName", type: "string", column: "id", resourceRef: "customer" },
  { gaql: "customer.descriptive_name", json: "customer.descriptiveName", type: "string", column: "descriptive_name" },
  { gaql: "customer.currency_code", json: "customer.currencyCode", type: "string", column: "currency_code" },
  { gaql: "customer.time_zone", json: "customer.timeZone", type: "string", column: "time_zone" },

  // campaign
  { gaql: "campaign.id", json: "campaign.id", type: "int64", column: "id" },
  { gaql: "campaign.resource_name", json: "campaign.resourceName", type: "string", column: "id", resourceRef: "campaign" },
  { gaql: "campaign.name", json: "campaign.name", type: "string", column: "name" },
  { gaql: "campaign.status", json: "campaign.status", type: "enum", column: "status", enumValues: CAMPAIGN_STATUSES },
  {
    gaql: "campaign.advertising_channel_type",
    json: "campaign.advertisingChannelType",
    type: "enum",
    column: "advertising_channel_type",
    enumValues: ["SEARCH", "DISPLAY", "SHOPPING", "VIDEO", "PERFORMANCE_MAX"],
  },
  {
    gaql: "campaign.bidding_strategy_type",
    json: "campaign.biddingStrategyType",
    type: "enum",
    column: "bidding_strategy_type",
    enumValues: ["TARGET_SPEND", "MANUAL_CPC", "MAXIMIZE_CONVERSIONS", "TARGET_CPA", "TARGET_ROAS"],
  },
  { gaql: "campaign.start_date", json: "campaign.startDate", type: "date", column: "start_date" },
  { gaql: "campaign.end_date", json: "campaign.endDate", type: "date", column: "end_date" },
  // The implicit join, spelled as the budget's resource name — this is how the
  // real API names an attached budget on the campaign resource.
  { gaql: "campaign.campaign_budget", json: "campaign.campaignBudget", type: "string", column: "budget_id", resourceRef: "campaign_budget" },

  // campaign_budget
  { gaql: "campaign_budget.id", json: "campaignBudget.id", type: "int64", column: "id" },
  { gaql: "campaign_budget.resource_name", json: "campaignBudget.resourceName", type: "string", column: "id", resourceRef: "campaign_budget" },
  { gaql: "campaign_budget.name", json: "campaignBudget.name", type: "string", column: "name" },
  { gaql: "campaign_budget.amount_micros", json: "campaignBudget.amountMicros", type: "int64", column: "amount_micros" },
  {
    gaql: "campaign_budget.delivery_method",
    json: "campaignBudget.deliveryMethod",
    type: "enum",
    column: "delivery_method",
    enumValues: ["STANDARD", "ACCELERATED"],
  },
  { gaql: "campaign_budget.period", json: "campaignBudget.period", type: "enum", column: "period", enumValues: ["DAILY"] },
  { gaql: "campaign_budget.explicitly_shared", json: "campaignBudget.explicitlyShared", type: "bool", column: "explicitly_shared" },
  { gaql: "campaign_budget.status", json: "campaignBudget.status", type: "enum", column: "status", enumValues: BUDGET_STATUSES },

  // ad_group
  { gaql: "ad_group.id", json: "adGroup.id", type: "int64", column: "id" },
  { gaql: "ad_group.resource_name", json: "adGroup.resourceName", type: "string", column: "id", resourceRef: "ad_group" },
  { gaql: "ad_group.name", json: "adGroup.name", type: "string", column: "name" },
  { gaql: "ad_group.status", json: "adGroup.status", type: "enum", column: "status", enumValues: CAMPAIGN_STATUSES },
  {
    gaql: "ad_group.type",
    json: "adGroup.type",
    type: "enum",
    column: "type",
    enumValues: ["SEARCH_STANDARD", "DISPLAY_STANDARD", "SHOPPING_PRODUCT_ADS", "VIDEO_TRUE_VIEW_IN_STREAM"],
  },
  { gaql: "ad_group.campaign", json: "adGroup.campaign", type: "string", column: "campaign_id", resourceRef: "campaign" },
  { gaql: "ad_group.cpc_bid_micros", json: "adGroup.cpcBidMicros", type: "int64", column: "cpc_bid_micros" },

  // segments — the only one this clone models, and the one that turns a report
  // from a total into a time series.
  { gaql: "segments.date", json: "segments.date", type: "date", column: "date" },

  // metrics
  { gaql: "metrics.impressions", json: "metrics.impressions", type: "int64", column: "impressions", metric: "sum" },
  { gaql: "metrics.clicks", json: "metrics.clicks", type: "int64", column: "clicks", metric: "sum" },
  { gaql: "metrics.cost_micros", json: "metrics.costMicros", type: "int64", column: "cost_micros", metric: "sum" },
  { gaql: "metrics.conversions", json: "metrics.conversions", type: "double", column: "conversions", metric: "sum" },
  { gaql: "metrics.conversions_value", json: "metrics.conversionsValue", type: "double", column: "conversions_value", metric: "sum" },
  { gaql: "metrics.ctr", json: "metrics.ctr", type: "double", metric: "computed" },
  { gaql: "metrics.average_cpc", json: "metrics.averageCpc", type: "double", metric: "computed" },
];

const BY_GAQL = new Map(FIELD_LIST.map((f) => [f.gaql, f]));

/** The resources you may reach from each FROM clause — the real implicit joins. */
export const JOINABLE: Record<ResourceKind, readonly ResourceKind[]> = {
  campaign: ["campaign", "campaign_budget", "customer"],
  ad_group: ["ad_group", "campaign", "campaign_budget", "customer"],
  campaign_budget: ["campaign_budget", "customer"],
  customer: ["customer"],
};

export const RESOURCE_KINDS = Object.keys(JOINABLE) as ResourceKind[];

export function isResourceKind(name: string): name is ResourceKind {
  return Object.prototype.hasOwnProperty.call(JOINABLE, name);
}

export function lookupField(gaql: string): FieldSpec | null {
  return BY_GAQL.get(gaql) ?? null;
}

/** The prefix before the first dot: `campaign_budget.amount_micros` → `campaign_budget`. */
export function resourceOf(gaql: string): Selectable {
  return gaql.slice(0, gaql.indexOf(".")) as Selectable;
}

/** The REST collection segment for each resource: `campaignBudgets`, `adGroups`, … */
const COLLECTION: Record<ResourceKind, string> = {
  customer: "customers",
  campaign: "campaigns",
  campaign_budget: "campaignBudgets",
  ad_group: "adGroups",
};

export function collectionFor(kind: ResourceKind): string {
  return COLLECTION[kind];
}

/**
 * The JSON object a resource's fields nest under in a response row. It is the
 * camelCase SINGULAR and never the collection — `campaign_budget` lands under
 * `campaignBudget`, not `campaignBudgets`, and a row that used the collection
 * name would be unreadable to every client written against the real API.
 */
const CONTAINER: Record<ResourceKind, string> = {
  customer: "customer",
  campaign: "campaign",
  campaign_budget: "campaignBudget",
  ad_group: "adGroup",
};

export function containerFor(kind: ResourceKind): string {
  return CONTAINER[kind];
}

/** `customers/4802938157/campaigns/17204885331` — resource names are paths. */
export function resourceNameFor(kind: ResourceKind, customerId: string, id?: string): string {
  if (kind === "customer") return `customers/${customerId}`;
  return `customers/${customerId}/${COLLECTION[kind]}/${id}`;
}
