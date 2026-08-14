// The Google Ads twin's half of the seed contract. The contract itself is
// written out in full at the top of packages/world/src/inject.ts; these are the
// shapes that arrive on the wire.
//
// Deliberately NOT typed against @sonata/core: a twin is a standalone app that
// must run (and be tested) with no orchestrator installed. Everything below is
// structurally compatible with core's world seed and injected-ref shapes, and
// that compatibility IS the contract.

/** Structurally core's `Person`. Only the fields this twin actually reads. */
export interface WirePerson {
  id: string;
  name: string;
  email: string;
}

/** Structurally core's `WorldSeed`. The cast is what makes the clone coherent. */
export interface WireWorld {
  business: { name: string };
  cast: WirePerson[];
  mailboxOwner: string;
  timezone?: string;
}

export interface GoogleAdsWireCustomer {
  /** Digits only — Google Ads customer ids cross the wire without dashes. */
  id: string;
  descriptiveName: string;
  currencyCode: string;
  timezone: string;
}

export interface GoogleAdsWireBudget {
  id: string;
  name: string;
  /** The currency unit × 1_000_000. A $250/day budget is 250000000. */
  amountMicros: number;
  deliveryMethod?: string;
  explicitlyShared?: boolean;
}

export interface GoogleAdsWireCampaign {
  id: string;
  budgetId: string;
  name: string;
  status: string;
  advertisingChannelType: string;
  biddingStrategyType?: string;
  /** YYYY-MM-DD in the account's zone. */
  startDate: string;
  endDate?: string;
}

export interface GoogleAdsWireAdGroup {
  id: string;
  campaignId: string;
  name: string;
  status: string;
  type?: string;
  cpcBidMicros?: number;
}

export interface GoogleAdsWireDailyStat {
  adGroupId: string;
  date: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions?: number;
  conversionsValue?: number;
}

export interface GoogleAdsWireSeed {
  world: WireWorld;
  /** The instant every relative offset in the source seed was resolved against. */
  nowISO: string;
  /** Make the seeded state the one `reset` returns to. Absent means no. */
  promoteToSnapshot?: boolean;
  ownerEmail: string;
  customer: GoogleAdsWireCustomer;
  budgets: GoogleAdsWireBudget[];
  campaigns: GoogleAdsWireCampaign[];
  adGroups: GoogleAdsWireAdGroup[];
  dailyStats: GoogleAdsWireDailyStat[];
}

export interface SeedRequest {
  twin: "google-ads";
  seed: GoogleAdsWireSeed;
}

/** `counts` is what was actually written, read back out of the DB. */
export interface SeedResult {
  ok: true;
  counts: { campaigns: number; adGroups: number; budgets: number; statRows: number };
}

// ---------------------------------------------------------------------------
// Validated form. Parsing turns the wire into exactly this and nothing else, so
// the writer cannot see an unchecked string or an unparsed timestamp.
// ---------------------------------------------------------------------------

export interface ParsedCustomer {
  id: string;
  descriptiveName: string;
  currencyCode: string;
  timezone: string;
}

export interface ParsedBudget {
  id: string;
  name: string;
  amountMicros: number;
  deliveryMethod: string;
  explicitlyShared: boolean;
}

export interface ParsedCampaign {
  id: string;
  budgetId: string;
  name: string;
  status: string;
  advertisingChannelType: string;
  biddingStrategyType: string;
  startDate: string;
  endDate: string | null;
}

export interface ParsedAdGroup {
  id: string;
  campaignId: string;
  name: string;
  status: string;
  type: string;
  cpcBidMicros: number | null;
}

export interface ParsedDailyStat {
  adGroupId: string;
  date: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
  conversionsValue: number;
}

export interface ParsedSeed {
  nowMs: number;
  ownerEmail: string;
  ownerName: string;
  businessName: string;
  promoteToSnapshot: boolean;
  customer: ParsedCustomer;
  budgets: ParsedBudget[];
  campaigns: ParsedCampaign[];
  adGroups: ParsedAdGroup[];
  dailyStats: ParsedDailyStat[];
}
