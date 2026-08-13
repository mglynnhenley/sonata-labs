import type { TwinHttp } from "../http";
import { fn, int, str, type EngineTool, type ToolInput } from "./types";

// The four Google Ads tools. Read two ways (what the account runs, what it
// spent), write two (pause or resume a campaign, move a budget).
//
// The twin's own product is its GAQL parser, and these tools deliberately do not
// hand it through: an agent asked to find the campaign that overspent should fail
// at judgement, not at remembering that `campaign_budget.amount_micros` is
// reachable from `FROM campaign` but `ad_group.name` is not. So each tool writes
// the query it needs, and what reaches the agent is the account.
//
// Two things are passed through undiluted, because they are the account and not
// the API: money is in MICROS, and a campaign that spent nothing inside a
// reporting window is absent from that report rather than present with a zero.
// Both are how the real API behaves, and an agent that learns otherwise here
// learns something false.

/** Campaigns per read. A cloned advertiser account runs tens of them. */
const MAX_ROWS = 100;

/** Rows in a day-by-day report — a fortnight across a handful of campaigns. */
const MAX_DAILY_ROWS = 300;

/** The version the twin's README and acceptance smoke are written against. */
const API_VERSION = "v17";

/** The windows the twin's GAQL grammar accepts, by name, and refuses outside. */
const DATE_RANGES = [
  "TODAY",
  "YESTERDAY",
  "LAST_7_DAYS",
  "LAST_14_DAYS",
  "LAST_30_DAYS",
  "THIS_MONTH",
  "LAST_MONTH",
];

const STATUSES = ["ENABLED", "PAUSED", "REMOVED"];

/** proto3 JSON: int64 fields cross the wire as strings, unset fields are absent. */
interface AdsRow {
  customer?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string };
  campaign?: {
    id?: string;
    name?: string;
    status?: string;
    advertisingChannelType?: string;
    startDate?: string;
    endDate?: string;
  };
  campaignBudget?: { id?: string; name?: string; amountMicros?: string };
  metrics?: {
    impressions?: string;
    clicks?: string;
    costMicros?: string;
    conversions?: number;
  };
  segments?: { date?: string };
}

function int64(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A Google Ads id, checked.
 *
 * Ids are decimal on this API, and these are the only agent-supplied values that
 * reach a query as text rather than as a bound argument — an unbalanced quote in
 * one would terminate the GAQL string early and the agent would get a parse error
 * about a query it never wrote. Refusing it here says the true thing instead.
 */
function requireId(value: unknown, field: string): string {
  const id = str(value).trim();
  if (!/^\d+$/.test(id)) {
    throw new Error(
      `${field} must be a Google Ads id — digits only, like 17204885331 — got ${JSON.stringify(value)}`,
    );
  }
  return id;
}

/** One of a fixed vocabulary, or a refusal that lists the vocabulary. */
function oneOf(value: string, allowed: string[], field: string): string {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")} — got "${value}"`);
  }
  return value;
}

/**
 * An amount of micros from a tool argument.
 *
 * Accepts the numeric string as well as the number, because int64 is a string on
 * this wire and a model that has just read `"250000000"` off a report will
 * reasonably send it back the same way. Anything else throws rather than
 * defaulting: this argument is money, and a silent fallback would write a budget
 * nobody asked for.
 */
function micros(value: unknown, field: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new Error(
      `${field} must be a whole number of micros — a $250.00 daily budget is 250000000 — got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

interface Account {
  customerId: string;
  name: string;
  currencyCode: string;
  timeZone: string;
}

export function googleAdsTools(http: TwinHttp): EngineTool[] {
  const api = `/${API_VERSION}`;
  let account: Account | undefined;

  /**
   * The one advertiser account this sandbox holds, resolved the way the real API
   * makes a client resolve it: list what you can reach, then ask that account
   * about itself. Memoised, so it costs two calls on the first tool use and none
   * after.
   */
  async function acct(): Promise<Account> {
    if (!account) {
      const list = await http.get<{ resourceNames?: string[] }>(
        `${api}/customers:listAccessibleCustomers`,
      );
      // A resource name is a path — `customers/4802938157` — and the id is its leaf.
      const customerId = list.resourceNames?.[0]?.split("/")[1];
      if (!customerId) throw new Error("this Google Ads sandbox holds no advertiser account");
      const res = await http.post<{ results?: AdsRow[] }>(
        `${api}/customers/${customerId}/googleAds:search`,
        {
          query:
            "SELECT customer.id, customer.descriptive_name, customer.currency_code, " +
            "customer.time_zone FROM customer",
        },
      );
      const row = res.results?.[0]?.customer;
      account = {
        customerId,
        name: row?.descriptiveName ?? "",
        currencyCode: row?.currencyCode ?? "",
        timeZone: row?.timeZone ?? "",
      };
    }
    return account;
  }

  async function search(query: string): Promise<AdsRow[]> {
    const { customerId } = await acct();
    const res = await http.post<{ results?: AdsRow[] }>(
      `${api}/customers/${customerId}/googleAds:search`,
      { query },
    );
    // No matches means no `results` key at all, which is proto3 JSON and not an
    // error — an empty list is the honest reading of it.
    return res.results ?? [];
  }

  function describe(r: AdsRow): Record<string, unknown> {
    return {
      campaignId: r.campaign?.id ?? "",
      name: r.campaign?.name ?? "",
      status: r.campaign?.status ?? "",
      channelType: r.campaign?.advertisingChannelType ?? "",
      startDate: r.campaign?.startDate ?? "",
      ...(r.campaign?.endDate ? { endDate: r.campaign.endDate } : {}),
      budgetId: r.campaignBudget?.id ?? "",
      budgetName: r.campaignBudget?.name ?? "",
      dailyBudgetMicros: int64(r.campaignBudget?.amountMicros),
    };
  }

  /** The campaign a write names, with the budget it is funded by. */
  async function campaignById(campaignId: string): Promise<AdsRow> {
    const rows = await search(
      "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.id, " +
        "campaign_budget.name, campaign_budget.amount_micros FROM campaign " +
        `WHERE campaign.id = ${campaignId}`,
    );
    const row = rows[0];
    if (!row) throw new Error(`no campaign ${campaignId} in this account — list_campaigns first`);
    return row;
  }

  return [
    {
      name: "list_campaigns",
      twin: "google-ads",
      isMutation: false,
      def: fn(
        "list_campaigns",
        "List the account's campaigns: what each one is called, whether it is running, and " +
          "the daily budget it draws on. Start here — every other tool takes a campaignId " +
          "from this list. Budgets are in micros: 250000000 is 250.00 a day.",
        {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: STATUSES,
              description: "Only campaigns in this state. Omit for all of them, removed included.",
            },
            maxResults: { type: "integer", description: "Default 50." },
          },
        },
      ),
      async run(input: ToolInput) {
        const status = str(input.status);
        if (status) oneOf(status, STATUSES, "status");
        const limit = Math.max(1, Math.min(int(input.maxResults, 50), MAX_ROWS));
        const rows = await search(
          "SELECT campaign.id, campaign.name, campaign.status, " +
            "campaign.advertising_channel_type, campaign.start_date, campaign.end_date, " +
            "campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros " +
            "FROM campaign " +
            (status ? `WHERE campaign.status = '${status}' ` : "") +
            `ORDER BY campaign.name LIMIT ${limit}`,
        );
        const { customerId, name, currencyCode, timeZone } = await acct();
        return {
          account: { customerId, name, currencyCode, timeZone },
          campaigns: rows.map(describe),
        };
      },
    },
    {
      name: "campaign_performance",
      twin: "google-ads",
      isMutation: false,
      def: fn(
        "campaign_performance",
        "What each campaign spent and earned over a window, biggest spender first, with its " +
          "daily budget alongside so overspend is visible in one read. A campaign with no " +
          "traffic in the window is ABSENT from this report rather than present with zeroes — " +
          "use list_campaigns for the full roster.",
        {
          type: "object",
          properties: {
            dateRange: {
              type: "string",
              enum: DATE_RANGES,
              description: "Default LAST_7_DAYS, which is the last seven days excluding today.",
            },
            byDay: {
              type: "boolean",
              description: "One row per campaign per day instead of one total per campaign.",
            },
            maxResults: { type: "integer", description: "Default 50, or 200 with byDay." },
          },
        },
      ),
      async run(input: ToolInput) {
        const dateRange = oneOf(str(input.dateRange) || "LAST_7_DAYS", DATE_RANGES, "dateRange");
        const byDay = input.byDay === true;
        // A day-by-day report is rows per campaign per day, so it needs a taller
        // default than a report that already totals them.
        const limit = Math.max(
          1,
          Math.min(int(input.maxResults, byDay ? 200 : 50), byDay ? MAX_DAILY_ROWS : MAX_ROWS),
        );
        const rows = await search(
          "SELECT campaign.id, campaign.name, campaign.status, " +
            "campaign_budget.amount_micros, metrics.impressions, metrics.clicks, " +
            `metrics.cost_micros, metrics.conversions${byDay ? ", segments.date" : ""} ` +
            `FROM campaign WHERE segments.date DURING ${dateRange} ` +
            // Ordered by spend when it is one row per campaign, because the
            // question is nearly always "which one ran away with the money". A
            // daily breakdown keeps the twin's default order — campaign, then
            // date — since a series sorted by cost is not a series.
            (byDay ? "" : "ORDER BY metrics.cost_micros DESC ") +
            `LIMIT ${limit}`,
        );
        const { currencyCode } = await acct();
        return {
          dateRange,
          currencyCode,
          rows: rows.map((r) => ({
            campaignId: r.campaign?.id ?? "",
            name: r.campaign?.name ?? "",
            status: r.campaign?.status ?? "",
            ...(r.segments?.date ? { date: r.segments.date } : {}),
            dailyBudgetMicros: int64(r.campaignBudget?.amountMicros),
            impressions: int64(r.metrics?.impressions),
            clicks: int64(r.metrics?.clicks),
            costMicros: int64(r.metrics?.costMicros),
            conversions: r.metrics?.conversions ?? 0,
          })),
        };
      },
    },
    {
      name: "set_campaign_status",
      twin: "google-ads",
      isMutation: true,
      def: fn(
        "set_campaign_status",
        "Pause a campaign, or put a paused one back on. Pausing stops its spend immediately " +
          "and someone is relying on that traffic, so say why somewhere first. REMOVED is " +
          "permanent — a removed campaign cannot be brought back, only rebuilt.",
        {
          type: "object",
          properties: {
            campaignId: { type: "string", description: "From list_campaigns." },
            status: { type: "string", enum: STATUSES },
          },
          required: ["campaignId", "status"],
        },
      ),
      async run(input: ToolInput) {
        const { customerId } = await acct();
        const campaignId = requireId(input.campaignId, "campaignId");
        // The status itself goes to the twin unchecked: it answers an unknown one
        // with the real API's own enum error, naming every value it accepts, which
        // is worth more to an agent than anything this file could say.
        const status = str(input.status);
        const resourceName = `customers/${customerId}/campaigns/${campaignId}`;
        await http.post(`${api}/customers/${customerId}/campaigns:mutate`, {
          operations: [
            // The updateMask is not decoration: a field in the body but not in the
            // mask is ignored, here and against the real account.
            { update: { resourceName, status }, updateMask: "status" },
          ],
        });
        return { campaignId, status, resourceName };
      },
    },
    {
      name: "set_campaign_budget",
      twin: "google-ads",
      isMutation: true,
      def: fn(
        "set_campaign_budget",
        "Change what a campaign may spend per day. The amount is in micros — 150000000 is " +
          "150.00 a day. Budgets can be SHARED: the reply names every campaign drawing on " +
          "the one you just moved, and they are all now capped by the new number.",
        {
          type: "object",
          properties: {
            campaignId: { type: "string", description: "From list_campaigns." },
            amountMicros: {
              type: "integer",
              description: "The new daily amount in micros. 150.00 a day is 150000000.",
            },
          },
          required: ["campaignId", "amountMicros"],
        },
      ),
      async run(input: ToolInput) {
        const { customerId } = await acct();
        const campaignId = requireId(input.campaignId, "campaignId");
        const amountMicros = micros(input.amountMicros, "amountMicros");

        const campaign = await campaignById(campaignId);
        const budgetId = campaign.campaignBudget?.id;
        if (!budgetId) {
          throw new Error(`campaign ${campaignId} has no budget attached to change`);
        }
        // Read who else draws on it BEFORE the write, so the answer describes the
        // blast radius of the change rather than a list that has already moved.
        const sharing = await search(
          "SELECT campaign.id, campaign.name FROM campaign " +
            `WHERE campaign_budget.id = ${budgetId} ORDER BY campaign.name LIMIT ${MAX_ROWS}`,
        );

        const resourceName = `customers/${customerId}/campaignBudgets/${budgetId}`;
        await http.post(`${api}/customers/${customerId}/campaignBudgets:mutate`, {
          operations: [
            {
              // int64 goes back as a string, the same way it arrived.
              update: { resourceName, amountMicros: String(amountMicros) },
              updateMask: "amountMicros",
            },
          ],
        });

        return {
          campaignId,
          budgetId,
          budgetName: campaign.campaignBudget?.name ?? "",
          fromMicros: int64(campaign.campaignBudget?.amountMicros),
          toMicros: amountMicros,
          resourceName,
          sharedWith: sharing
            .filter((r) => r.campaign?.id !== campaignId)
            .map((r) => r.campaign?.name ?? ""),
        };
      },
    },
  ];
}
