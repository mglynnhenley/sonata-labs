import { DATE_RE } from "../googleads/dates";
import { lookupField } from "../googleads/resources";
import { BadRequestError } from "./auth";
import type {
  ParsedAdGroup,
  ParsedBudget,
  ParsedCampaign,
  ParsedCustomer,
  ParsedDailyStat,
  ParsedSeed,
  WirePerson,
} from "./types";

// Validating a cloned advertiser account on the way in. Everything here fails
// loudly with a message that names the offending path and says what to fix: a
// seed that is half-understood produces an account the agent quietly reasons
// about wrongly, which is far worse than a run that refuses to start.
//
// Google Ads resources name no people — a campaign has no organizer and a budget
// has no owner — so the cast rule that does the heavy lifting in the Gmail and
// Calendar twins has exactly one place to bite here: `ownerEmail`. It still
// bites, because a twin must never invent an identity, and the account owner is
// the one identity this twin holds.

export { BadRequestError };

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestError(`${where} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function array(source: Record<string, unknown>, key: string, where: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new BadRequestError(`${where}.${key} must be an array`);
  return value;
}

/** For the list fields a hand-written seed reasonably leaves off entirely. */
function optionalArray(source: Record<string, unknown>, key: string, where: string): unknown[] {
  return source[key] === undefined || source[key] === null ? [] : array(source, key, where);
}

function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestError(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalText(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new BadRequestError(`${where}.${key} must be a string`);
  return value;
}

function flag(source: Record<string, unknown>, key: string, where: string): boolean {
  const value = source[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new BadRequestError(`${where}.${key} must be a boolean`);
  return value;
}

function instant(source: Record<string, unknown>, key: string, where: string): number {
  const raw = text(source, key, where);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new BadRequestError(`${where}.${key} must be an absolute ISO 8601 timestamp, got "${raw}"`);
  }
  return ms;
}

/** An unknown zone would throw on every later date computation, so reject it at the door. */
function timezone(source: Record<string, unknown>, key: string, where: string): string {
  const zone = text(source, key, where);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new BadRequestError(`${where}.${key} "${zone}" is not an IANA time zone`);
  }
  return zone;
}

function date(source: Record<string, unknown>, key: string, where: string): string {
  const raw = text(source, key, where);
  if (!DATE_RE.test(raw)) {
    throw new BadRequestError(`${where}.${key} "${raw}" must be YYYY-MM-DD`);
  }
  return raw;
}

/** Micros are whole and never negative; a float here is a factor-of-a-million bug. */
function micros(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestError(
      `${where}.${key} must be a non-negative whole number of micros (a $250 budget is 250000000), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function count(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestError(`${where}.${key} must be a non-negative whole number`);
  }
  return value;
}

function amount(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key];
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BadRequestError(`${where}.${key} must be a non-negative number`);
  }
  return value;
}

/**
 * Enum values are checked against the same catalogue the GAQL parser reads, so a
 * seed can never introduce a status no query could ever match.
 */
function enumValue(
  source: Record<string, unknown>,
  key: string,
  where: string,
  gaqlField: string,
  fallback?: string,
): string {
  const allowed = lookupField(gaqlField)?.enumValues ?? [];
  const raw = source[key];
  if ((raw === undefined || raw === null) && fallback !== undefined) return fallback;
  if (typeof raw !== "string" || !allowed.includes(raw)) {
    throw new BadRequestError(
      `${where}.${key} must be one of ${allowed.join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function castOf(world: Record<string, unknown>): WirePerson[] {
  return array(world, "cast", "seed.world").map((entry, i) => {
    const where = `seed.world.cast[${i}]`;
    const person = object(entry, where);
    return {
      id: text(person, "id", where),
      name: text(person, "name", where),
      email: text(person, "email", where),
    };
  });
}

function parseCustomer(raw: unknown): ParsedCustomer {
  const where = "seed.customer";
  const source = object(raw, where);
  const id = text(source, "id", where);
  if (!/^\d+$/.test(id)) {
    throw new BadRequestError(
      `${where}.id "${id}" must be digits only — Google Ads customer ids cross the wire without dashes`,
    );
  }
  return {
    id,
    descriptiveName: text(source, "descriptiveName", where),
    currencyCode: text(source, "currencyCode", where),
    timezone: timezone(source, "timezone", where),
  };
}

function parseBudgets(entries: unknown[]): ParsedBudget[] {
  const ids = new Set<string>();
  const budgets = entries.map((entry, i) => {
    const where = `seed.budgets[${i}]`;
    const raw = object(entry, where);
    const id = text(raw, "id", where);
    if (ids.has(id)) throw new BadRequestError(`seed.budgets has two budgets with id "${id}"`);
    ids.add(id);
    return {
      id,
      name: text(raw, "name", where),
      amountMicros: micros(raw, "amountMicros", where),
      deliveryMethod: enumValue(raw, "deliveryMethod", where, "campaign_budget.delivery_method", "STANDARD"),
      explicitlyShared: flag(raw, "explicitlyShared", where),
    };
  });
  if (!budgets.length) {
    throw new BadRequestError("seed.budgets must contain at least one budget — every campaign needs one");
  }
  return budgets;
}

function parseCampaigns(entries: unknown[], budgets: ParsedBudget[]): ParsedCampaign[] {
  const budgetIds = new Set(budgets.map((b) => b.id));
  const ids = new Set<string>();
  return entries.map((entry, i) => {
    const where = `seed.campaigns[${i}]`;
    const raw = object(entry, where);
    const id = text(raw, "id", where);
    if (ids.has(id)) throw new BadRequestError(`seed.campaigns has two campaigns with id "${id}"`);
    ids.add(id);

    const budgetId = text(raw, "budgetId", where);
    if (!budgetIds.has(budgetId)) {
      throw new BadRequestError(
        `${where}.budgetId "${budgetId}" names no budget in seed.budgets — a campaign can only ` +
          `point at a budget this seed creates`,
      );
    }

    const endDate = optionalText(raw, "endDate", where);
    if (endDate && !DATE_RE.test(endDate)) {
      throw new BadRequestError(`${where}.endDate "${endDate}" must be YYYY-MM-DD`);
    }

    return {
      id,
      budgetId,
      name: text(raw, "name", where),
      status: enumValue(raw, "status", where, "campaign.status"),
      advertisingChannelType: enumValue(raw, "advertisingChannelType", where, "campaign.advertising_channel_type"),
      biddingStrategyType: enumValue(raw, "biddingStrategyType", where, "campaign.bidding_strategy_type", "TARGET_SPEND"),
      startDate: date(raw, "startDate", where),
      endDate: endDate || null,
    };
  });
}

function parseAdGroups(entries: unknown[], campaigns: ParsedCampaign[]): ParsedAdGroup[] {
  const campaignIds = new Set(campaigns.map((c) => c.id));
  const ids = new Set<string>();
  return entries.map((entry, i) => {
    const where = `seed.adGroups[${i}]`;
    const raw = object(entry, where);
    const id = text(raw, "id", where);
    if (ids.has(id)) throw new BadRequestError(`seed.adGroups has two ad groups with id "${id}"`);
    ids.add(id);

    const campaignId = text(raw, "campaignId", where);
    if (!campaignIds.has(campaignId)) {
      throw new BadRequestError(
        `${where}.campaignId "${campaignId}" names no campaign in seed.campaigns`,
      );
    }

    const bid = raw.cpcBidMicros;
    return {
      id,
      campaignId,
      name: text(raw, "name", where),
      status: enumValue(raw, "status", where, "ad_group.status"),
      type: enumValue(raw, "type", where, "ad_group.type", "SEARCH_STANDARD"),
      cpcBidMicros: bid === undefined || bid === null ? null : micros(raw, "cpcBidMicros", where),
    };
  });
}

function parseDailyStats(entries: unknown[], adGroups: ParsedAdGroup[]): ParsedDailyStat[] {
  const adGroupIds = new Set(adGroups.map((a) => a.id));
  const seen = new Set<string>();
  return entries.map((entry, i) => {
    const where = `seed.dailyStats[${i}]`;
    const raw = object(entry, where);

    const adGroupId = text(raw, "adGroupId", where);
    if (!adGroupIds.has(adGroupId)) {
      throw new BadRequestError(
        `${where}.adGroupId "${adGroupId}" names no ad group in seed.adGroups`,
      );
    }
    const day = date(raw, "date", where);
    const key = `${adGroupId}/${day}`;
    // The table is keyed on the pair, so a duplicate would silently overwrite
    // and the account would spend less than the seed says it did.
    if (seen.has(key)) {
      throw new BadRequestError(`seed.dailyStats has two rows for ad group "${adGroupId}" on ${day}`);
    }
    seen.add(key);

    return {
      adGroupId,
      date: day,
      impressions: count(raw, "impressions", where),
      clicks: count(raw, "clicks", where),
      costMicros: micros(raw, "costMicros", where),
      conversions: amount(raw, "conversions", where),
      conversionsValue: amount(raw, "conversionsValue", where),
    };
  });
}

/** The whole request, checked. Throws `BadRequestError` with a fixable message. */
export function parseSeedRequest(body: unknown): ParsedSeed {
  const root = object(body, "body");

  // Redundant with the URL on purpose: a mis-routed seed has to be loud, because
  // the alternative is an empty account that answers 200.
  if (root.twin !== "google-ads") {
    throw new BadRequestError(
      `this twin seeds 'google-ads', not ${JSON.stringify(root.twin)} — post the Google Ads ` +
        `wire seed here and the others to their own twins`,
    );
  }

  const seed = object(root.seed, "seed");
  const world = object(seed.world, "seed.world");
  const cast = castOf(world);
  const known = new Map(cast.map((p) => [p.email.toLowerCase(), p.name]));

  const ownerEmail = text(seed, "ownerEmail", "seed");
  const ownerName = known.get(ownerEmail.toLowerCase());
  if (ownerName === undefined) {
    throw new BadRequestError(
      `seed.ownerEmail "${ownerEmail}" is not in seed.world.cast — the account owner must be a ` +
        `member of the cast the other twins seeded from`,
    );
  }

  const customer = parseCustomer(seed.customer);
  const budgets = parseBudgets(array(seed, "budgets", "seed"));
  const campaigns = parseCampaigns(array(seed, "campaigns", "seed"), budgets);
  const adGroups = parseAdGroups(array(seed, "adGroups", "seed"), campaigns);
  const dailyStats = parseDailyStats(optionalArray(seed, "dailyStats", "seed"), adGroups);
  const business = object(world.business, "seed.world.business");

  const promote = seed.promoteToSnapshot;
  if (promote !== undefined && typeof promote !== "boolean") {
    throw new BadRequestError("seed.promoteToSnapshot must be a boolean when present");
  }

  return {
    nowMs: instant(seed, "nowISO", "seed"),
    ownerEmail,
    ownerName,
    businessName: text(business, "name", "seed.world.business"),
    promoteToSnapshot: promote === true,
    customer,
    budgets,
    campaigns,
    adGroups,
    dailyStats,
  };
}
