import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { listActions } from "@/lib/audit";
import { GoogleAdsError } from "@/lib/googleads/errors";
import { applyOperations, type MutateOperation, type MutateOptions } from "@/lib/googleads/mutate";
import { runMutation } from "@/lib/googleads/route-helpers";
import { getBudget, listBudgets } from "@/lib/store/budgets";
import { getCampaign } from "@/lib/store/campaigns";
import {
  BUDGET_OVER,
  BUDGET_QUIET,
  CAMPAIGN_OVER,
  CAMPAIGN_PAUSED,
  CUSTOMER_ID,
  makeTestDb,
} from "./helpers";

// The mutate pipeline. The updateMask rules carry most of the weight here,
// because they are the part an agent gets wrong silently: a lenient clone that
// applied every field it found would teach exactly the wrong lesson.

let db: Database;

const CAMPAIGN_NAME = `customers/${CUSTOMER_ID}/campaigns/${CAMPAIGN_OVER}`;
const BUDGET_NAME = `customers/${CUSTOMER_ID}/campaignBudgets/${BUDGET_OVER}`;

function options(over: Partial<MutateOptions> = {}): MutateOptions {
  return {
    resource: "campaign",
    customerId: CUSTOMER_ID,
    currencyCode: "USD",
    apiVersion: "v17",
    operations: [],
    partialFailure: false,
    validateOnly: false,
    endpoint: "/v17/customers/4802938157/campaigns:mutate",
    ...over,
  };
}

/** The route's own path: the batch and its audit rows commit together or not at all. */
function mutate(over: Partial<MutateOptions>) {
  const opts = options(over);
  return runMutation(
    db,
    () => applyOperations(db, opts),
    (result) => result.entries,
  );
}

function failure(over: Partial<MutateOptions>): GoogleAdsError {
  try {
    mutate(over);
  } catch (err) {
    if (err instanceof GoogleAdsError) return err;
    throw err;
  }
  throw new Error("expected the mutate to fail");
}

const pause: MutateOperation = {
  update: { resourceName: CAMPAIGN_NAME, status: "PAUSED" },
  updateMask: "status",
};

beforeEach(() => {
  db = makeTestDb();
});

describe("updateMask", () => {
  it("ignores a field present in the body but absent from the mask", () => {
    mutate({
      operations: [
        {
          update: { resourceName: CAMPAIGN_NAME, status: "PAUSED", name: "Renamed by accident" },
          updateMask: "status",
        },
      ],
    });
    const row = getCampaign(db, CAMPAIGN_OVER);
    expect(row?.status).toBe("PAUSED");
    expect(row?.name).toBe("Acme — Payments Integration (Search)");
  });

  it("accepts snake_case and camelCase mask paths alike", () => {
    mutate({
      operations: [
        { update: { resourceName: CAMPAIGN_NAME, start_date: "2026-04-01" }, updateMask: "start_date" },
      ],
    });
    expect(getCampaign(db, CAMPAIGN_OVER)?.start_date).toBe("2026-04-01");
    mutate({
      operations: [
        { update: { resourceName: CAMPAIGN_NAME, startDate: "2026-05-01" }, updateMask: "startDate" },
      ],
    });
    expect(getCampaign(db, CAMPAIGN_OVER)?.start_date).toBe("2026-05-01");
  });

  it("refuses a mask naming an unknown or immutable field", () => {
    const err = failure({
      operations: [
        { update: { resourceName: CAMPAIGN_NAME, id: "1" }, updateMask: "advertisingChannelType" },
      ],
    });
    expect(err.errorCode).toEqual({ fieldMaskError: "FIELD_NOT_FOUND" });
    expect(err.message).toContain("advertisingChannelType");
  });

  it("refuses a mask naming a budget's status", () => {
    // Google has no settable status on a budget — it is removed, never patched to
    // REMOVED — which is why BudgetPatch carries no status for this to reach.
    const err = failure({
      resource: "campaignBudget",
      operations: [{ update: { resourceName: BUDGET_NAME, status: "REMOVED" }, updateMask: "status" }],
    });
    expect(err.errorCode).toEqual({ fieldMaskError: "FIELD_NOT_FOUND" });
    expect(getBudget(db, BUDGET_OVER)?.status).toBe("ENABLED");
  });

  it("refuses an update with no mask at all", () => {
    const err = failure({ operations: [{ update: { resourceName: CAMPAIGN_NAME, status: "PAUSED" } }] });
    expect(err.errorCode).toEqual({ fieldMaskError: "FIELD_MASK_MISSING" });
  });

  it("refuses a mask entry the operation body does not carry", () => {
    const err = failure({
      operations: [{ update: { resourceName: CAMPAIGN_NAME }, updateMask: "status" }],
    });
    expect(err.errorCode).toEqual({ fieldError: "REQUIRED" });
  });
});

describe("resource names", () => {
  it("refuses a malformed one", () => {
    const err = failure({ operations: [{ update: { resourceName: "campaigns/17204885331" }, updateMask: "status" }] });
    expect(err.errorCode).toEqual({ requestError: "RESOURCE_NAME_MALFORMED" });
  });

  it("reports a well-formed name for an absent row as not found", () => {
    const err = failure({
      operations: [
        {
          update: { resourceName: `customers/${CUSTOMER_ID}/campaigns/99999999999`, status: "PAUSED" },
          updateMask: "status",
        },
      ],
    });
    expect(err.errorCode).toEqual({ mutateError: "RESOURCE_NOT_FOUND" });
    expect(err.httpStatus).toBe(400);
  });

  it("reports another customer's resource as not found too", () => {
    const err = failure({
      operations: [
        {
          update: { resourceName: `customers/1111111111/campaigns/${CAMPAIGN_OVER}`, status: "PAUSED" },
          updateMask: "status",
        },
      ],
    });
    expect(err.errorCode).toEqual({ mutateError: "RESOURCE_NOT_FOUND" });
  });
});

describe("remove", () => {
  it("soft-deletes a campaign, leaving it queryable", () => {
    mutate({ operations: [{ remove: CAMPAIGN_NAME }] });
    expect(getCampaign(db, CAMPAIGN_OVER)?.status).toBe("REMOVED");
  });

  it("refuses to remove a budget a live campaign still points at", () => {
    const err = failure({
      resource: "campaignBudget",
      operations: [{ remove: BUDGET_NAME }],
    });
    expect(err.errorCode).toEqual({ campaignBudgetError: "CAMPAIGN_BUDGET_IN_USE" });
    expect(getBudget(db, BUDGET_OVER)?.status).toBe("ENABLED");
  });

  it("allows it once nothing points at it", () => {
    mutate({ operations: [{ remove: CAMPAIGN_NAME }] });
    mutate({ resource: "campaignBudget", operations: [{ remove: BUDGET_NAME }] });
    expect(getBudget(db, BUDGET_OVER)?.status).toBe("REMOVED");
  });
});

describe("create", () => {
  it("mints a budget id in Google's alphabet and flags it sandbox-created", () => {
    const outcome = mutate({
      resource: "campaignBudget",
      operations: [{ create: { name: "Payments daily budget v2", amountMicros: 400_000_000 } }],
    });
    const name = outcome.results[0].resourceName as string;
    expect(name).toMatch(new RegExp(`^customers/${CUSTOMER_ID}/campaignBudgets/\\d{10,12}$`));
    const created = listBudgets(db, CUSTOMER_ID).find((b) => b.is_sandbox_created === 1);
    expect(created?.amount_micros).toBe(400_000_000);
  });

  it("refuses a campaign create with a 501 that names the alternative", () => {
    const err = failure({ operations: [{ create: { name: "New campaign" } }] });
    expect(err.httpStatus).toBe(501);
    expect(err.errorCode).toEqual({ mutateError: "MUTATE_NOT_ALLOWED" });
    expect(err.message).toContain("Create a budget");
  });
});

describe("flags", () => {
  it("validateOnly validates, returns no results, writes nothing and logs nothing", () => {
    const outcome = mutate({ operations: [pause], validateOnly: true });
    // Google returns errors and not results from a dry run. An agent that learned
    // to read results[0].resourceName here would read undefined for real.
    expect(outcome.results).toEqual([]);
    expect(getCampaign(db, CAMPAIGN_OVER)?.status).toBe("ENABLED");
    expect(listActions(db)).toHaveLength(0);
  });

  it("validateOnly still runs every check", () => {
    const err = failure({
      operations: [{ update: { resourceName: CAMPAIGN_NAME, status: "SNOOZED" }, updateMask: "status" }],
      validateOnly: true,
    });
    expect(err.errorCode).toEqual({ fieldError: "INVALID_VALUE" });
  });

  it("aborts the whole batch on the first failure when partialFailure is off", () => {
    const err = failure({
      operations: [pause, { update: { resourceName: "nonsense" }, updateMask: "status" }],
    });
    expect(err.errorCode).toEqual({ requestError: "RESOURCE_NAME_MALFORMED" });
    // Neither the applied operation nor its audit row survived.
    expect(getCampaign(db, CAMPAIGN_OVER)?.status).toBe("ENABLED");
    expect(listActions(db)).toHaveLength(0);
  });

  it("reports the failed slot by index when partialFailure is on", () => {
    const outcome = mutate({
      operations: [pause, { update: { resourceName: "nonsense" }, updateMask: "status" }],
      partialFailure: true,
    });
    expect(outcome.results).toEqual([{ resourceName: CAMPAIGN_NAME }, {}]);
    const failed = outcome.partialFailureError!;
    expect(failed.code).toBe(3);
    expect(failed.details[0].errors[0].location).toEqual({
      fieldPathElements: [{ fieldName: "operations", index: 1 }],
    });
    // The operations that DID apply are still applied.
    expect(getCampaign(db, CAMPAIGN_OVER)?.status).toBe("PAUSED");
  });
});

describe("audit", () => {
  it("writes one row per applied operation, in one session, naming the change", () => {
    mutate({
      operations: [
        pause,
        { update: { resourceName: `customers/${CUSTOMER_ID}/campaigns/${CAMPAIGN_PAUSED}`, status: "ENABLED" }, updateMask: "status" },
      ],
    });
    const rows = listActions(db);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.session_id)).size).toBe(1);
    expect(rows.map((r) => r.summary).sort()).toEqual([
      "Enabled “Acme — Northwind ABM (Search)”",
      "Paused “Acme — Payments Integration (Search)”",
    ]);
    expect(rows.every((r) => r.action_type === "campaignUpdate" && r.target_type === "campaign")).toBe(
      true,
    );
  });

  it("names the money in a budget summary", () => {
    mutate({
      resource: "campaignBudget",
      operations: [
        { update: { resourceName: BUDGET_NAME, amountMicros: 400_000_000 }, updateMask: "amountMicros" },
      ],
    });
    expect(listActions(db)[0].summary).toBe(
      "Raised “Payments daily budget” from $250.00 to $400.00/day",
    );
  });

  it("says lowered when it is lowered", () => {
    mutate({
      resource: "campaignBudget",
      operations: [
        {
          update: { resourceName: `customers/${CUSTOMER_ID}/campaignBudgets/${BUDGET_QUIET}`, amountMicros: 30_000_000 },
          updateMask: "amount_micros",
        },
      ],
    });
    expect(listActions(db)[0].summary).toBe(
      "Lowered “Northwind ABM daily budget” from $60.00 to $30.00/day",
    );
  });
});
