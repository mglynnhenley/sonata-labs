import type { Database } from "better-sqlite3";
import type { ActionEntry } from "../audit";
import {
  GoogleAdsError,
  mutateResourceNotFound,
  requestError,
  type GoogleAdsErrorItem,
} from "./errors";
import { newBudgetId } from "./ids";
import { collectionFor, lookupField, resourceNameFor, type ResourceKind } from "./resources";
import { DATE_RE } from "./dates";
import {
  budgetIsAttached,
  getBudget,
  insertBudget,
  removeBudget,
  updateBudget,
  type BudgetPatch,
} from "../store/budgets";
import { getCampaign, removeCampaign, updateCampaign, type CampaignPatch } from "../store/campaigns";

// The operations executor, shared by campaigns:mutate and campaignBudgets:mutate.
//
// The updateMask is the whole lesson and it is not decoration: a field that is
// present in the operation body but absent from the mask is IGNORED. An agent
// that learns otherwise here — because a lenient clone applied everything it
// found — will one day send a full resource with a one-field mask against a real
// account and be surprised by what did not change.
//
// Mask entries are accepted in EITHER camelCase or snake_case, because agents
// copy snake_case out of GAQL and camelCase out of the REST docs, and rejecting
// one of the two would be a coin flip they lose half the time.

export type MutateResource = "campaign" | "campaignBudget";

/** The resource kind each mutate endpoint addresses, for names and lookups. */
const KIND: Record<MutateResource, ResourceKind> = {
  campaign: "campaign",
  campaignBudget: "campaign_budget",
};

const MUTABLE: Record<MutateResource, readonly string[]> = {
  campaign: ["name", "status", "startDate", "endDate", "campaignBudget"],
  campaignBudget: ["name", "amountMicros", "deliveryMethod", "explicitlyShared"],
};

/** Fields whose mask entry may legitimately arrive with no value — a clear. */
const CLEARABLE = new Set(["endDate"]);

export interface MutateOperation {
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
  updateMask?: string;
  remove?: string;
}

export interface RpcStatus {
  code: number;
  message: string;
  details: Array<{ "@type": string; errors: GoogleAdsErrorItem[] }>;
}

export interface MutateOptions {
  resource: MutateResource;
  customerId: string;
  currencyCode: string;
  apiVersion: string;
  operations: unknown;
  partialFailure: boolean;
  validateOnly: boolean;
  endpoint: string;
}

export interface MutateOutcome {
  results: Array<{ resourceName?: string }>;
  partialFailureError?: RpcStatus;
  entries: ActionEntry[];
}

function fieldError(code: string, message: string): GoogleAdsError {
  return new GoogleAdsError(400, { fieldError: code }, message);
}

function maskError(code: string, message: string): GoogleAdsError {
  return new GoogleAdsError(400, { fieldMaskError: code }, message);
}

function camelCase(path: string): string {
  return path.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function formatMoney(micros: number, currencyCode: string): string {
  const amount = (micros / 1_000_000).toFixed(2);
  return currencyCode === "USD" ? `$${amount}` : `${amount} ${currencyCode}`;
}

/**
 * `customers/<cid>/<collection>/<id>` → the id. A name for another customer is a
 * not-found rather than a permission error, matching the real API: the sandbox
 * holds one account, and a caller who guessed a different id has simply named a
 * row that is not there.
 */
function idFromResourceName(raw: unknown, resource: MutateResource, customerId: string): string {
  if (typeof raw !== "string" || !raw) {
    throw requestError("RESOURCE_NAME_MISSING", "The resource name is missing.");
  }
  const pattern = new RegExp(`^customers/(\\d+)/${collectionFor(KIND[resource])}/(\\d+)$`);
  const m = pattern.exec(raw);
  if (!m) {
    throw new GoogleAdsError(
      400,
      { requestError: "RESOURCE_NAME_MALFORMED" },
      "Resource name is malformed.",
      { trigger: raw },
    );
  }
  if (m[1] !== customerId) throw mutateResourceNotFound(raw);
  return m[2];
}

function requireEnum(gaqlField: string, value: unknown): string {
  const allowed = lookupField(gaqlField)?.enumValues ?? [];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw fieldError(
      "INVALID_VALUE",
      `'${String(value)}' is not a valid ${gaqlField}; expected one of ${allowed.join(", ")}.`,
    );
  }
  return value;
}

function requireDate(field: string, value: unknown): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw fieldError("INVALID_VALUE", `${field} must be a YYYY-MM-DD date, got '${String(value)}'.`);
  }
  return value;
}

/** Micros arrive as a JSON number or, for int64 fidelity, as a decimal string. */
function requireMicros(field: string, value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw fieldError(
      "INVALID_VALUE",
      `${field} must be a non-negative whole number of micros, got '${String(value)}'.`,
    );
  }
  return n;
}

function maskPaths(op: MutateOperation, resource: MutateResource): string[] {
  if (typeof op.updateMask !== "string" || !op.updateMask.trim()) {
    throw maskError("FIELD_MASK_MISSING", "The field mask must be provided for update operations.");
  }
  return op.updateMask.split(",").map((raw) => {
    const path = camelCase(raw.trim());
    if (!MUTABLE[resource].includes(path)) {
      throw maskError(
        "FIELD_NOT_FOUND",
        `The field mask contained an invalid field: '${raw.trim()}'. ` +
          `Mutable fields on ${resource} are ${MUTABLE[resource].join(", ")}.`,
      );
    }
    return path;
  });
}

function valueFor(body: Record<string, unknown>, path: string): unknown {
  // Accept the snake_case spelling in the body too, for the same reason the mask
  // does: one half of the docs writes it that way.
  const snake = path.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const value = body[path] ?? body[snake];
  if (value === undefined && !CLEARABLE.has(path)) {
    throw fieldError("REQUIRED", `The field mask names '${path}' but the operation omits it.`);
  }
  return value;
}

// --- per-resource operations -------------------------------------------------

interface Applied {
  resourceName: string;
  entry: ActionEntry;
}

function updateCampaignOp(
  db: Database,
  op: MutateOperation,
  opts: MutateOptions,
  validateOnly: boolean,
): Applied {
  const body = op.update as Record<string, unknown>;
  const id = idFromResourceName(body.resourceName ?? body.resource_name, "campaign", opts.customerId);
  const row = getCampaign(db, id);
  if (!row) throw mutateResourceNotFound(resourceNameFor("campaign", opts.customerId, id));

  const patch: CampaignPatch = {};
  const changes: string[] = [];
  for (const path of maskPaths(op, "campaign")) {
    const value = valueFor(body, path);
    switch (path) {
      case "name":
        patch.name = String(value);
        changes.push(`name → “${patch.name}”`);
        break;
      case "status":
        patch.status = requireEnum("campaign.status", value);
        changes.push(`status → ${patch.status}`);
        break;
      case "startDate":
        patch.startDate = requireDate("startDate", value);
        changes.push(`startDate → ${patch.startDate}`);
        break;
      case "endDate":
        patch.endDate = value === undefined || value === null ? null : requireDate("endDate", value);
        changes.push(patch.endDate ? `endDate → ${patch.endDate}` : "endDate cleared");
        break;
      default: {
        const budgetId = idFromResourceName(value, "campaignBudget", opts.customerId);
        if (!getBudget(db, budgetId)) throw mutateResourceNotFound(String(value));
        patch.budgetId = budgetId;
        changes.push(`budget → ${budgetId}`);
      }
    }
  }

  const resourceName = resourceNameFor("campaign", opts.customerId, id);
  if (!validateOnly) updateCampaign(db, id, patch);

  // The verb is the point of the summary: "Paused X" is what a judge is looking
  // for, and "Updated X: status → PAUSED" buries it.
  const summary =
    patch.status && Object.keys(patch).length === 1
      ? `${patch.status === "PAUSED" ? "Paused" : patch.status === "ENABLED" ? "Enabled" : "Removed"} “${row.name}”`
      : `Updated “${row.name}”: ${changes.join(", ")}`;

  return {
    resourceName,
    entry: {
      method: "POST",
      endpoint: opts.endpoint,
      actionType: "campaignUpdate",
      targetType: "campaign",
      targetId: id,
      request: op,
      responseCode: 200,
      summary,
    },
  };
}

function removeCampaignOp(db: Database, op: MutateOperation, opts: MutateOptions, validateOnly: boolean): Applied {
  const id = idFromResourceName(op.remove, "campaign", opts.customerId);
  const row = getCampaign(db, id);
  if (!row) throw mutateResourceNotFound(String(op.remove));
  if (!validateOnly) removeCampaign(db, id);
  return {
    resourceName: resourceNameFor("campaign", opts.customerId, id),
    entry: {
      method: "POST",
      endpoint: opts.endpoint,
      actionType: "campaignRemove",
      targetType: "campaign",
      targetId: id,
      request: op,
      responseCode: 200,
      summary: `Removed campaign “${row.name}”`,
    },
  };
}

function createBudgetOp(db: Database, op: MutateOperation, opts: MutateOptions, validateOnly: boolean): Applied {
  const body = op.create as Record<string, unknown>;
  const name = body.name;
  if (typeof name !== "string" || !name.trim()) {
    throw requestError("REQUIRED_FIELD_MISSING", "The request is missing required information.");
  }
  const amountMicros = requireMicros("amountMicros", body.amountMicros ?? body.amount_micros);
  const deliveryMethod =
    body.deliveryMethod === undefined && body.delivery_method === undefined
      ? "STANDARD"
      : requireEnum("campaign_budget.delivery_method", body.deliveryMethod ?? body.delivery_method);

  const id = newBudgetId();
  if (!validateOnly) {
    insertBudget(db, {
      id,
      customerId: opts.customerId,
      name,
      amountMicros,
      deliveryMethod,
      // The one flag that separates the agent's own budget from the world's.
      isSandboxCreated: true,
    });
  }
  return {
    resourceName: resourceNameFor("campaign_budget", opts.customerId, id),
    entry: {
      method: "POST",
      endpoint: opts.endpoint,
      actionType: "budgetCreate",
      targetType: "campaignBudget",
      targetId: id,
      request: op,
      responseCode: 200,
      summary: `Created budget “${name}” at ${formatMoney(amountMicros, opts.currencyCode)}/day`,
    },
  };
}

function updateBudgetOp(db: Database, op: MutateOperation, opts: MutateOptions, validateOnly: boolean): Applied {
  const body = op.update as Record<string, unknown>;
  const id = idFromResourceName(body.resourceName ?? body.resource_name, "campaignBudget", opts.customerId);
  const row = getBudget(db, id);
  if (!row) throw mutateResourceNotFound(resourceNameFor("campaign_budget", opts.customerId, id));

  const patch: BudgetPatch = {};
  const changes: string[] = [];
  for (const path of maskPaths(op, "campaignBudget")) {
    const value = valueFor(body, path);
    switch (path) {
      case "name":
        patch.name = String(value);
        changes.push(`name → “${patch.name}”`);
        break;
      case "amountMicros":
        patch.amountMicros = requireMicros("amountMicros", value);
        break;
      case "deliveryMethod":
        patch.deliveryMethod = requireEnum("campaign_budget.delivery_method", value);
        changes.push(`delivery → ${patch.deliveryMethod}`);
        break;
      default:
        patch.explicitlyShared = Boolean(value);
        changes.push(`explicitlyShared → ${patch.explicitlyShared}`);
    }
  }

  if (!validateOnly) updateBudget(db, id, patch);

  // The money is the story a judge reads, so it leads: the direction and both
  // amounts, not "amountMicros → 400000000".
  const before = formatMoney(row.amount_micros, opts.currencyCode);
  const money =
    patch.amountMicros === undefined
      ? null
      : patch.amountMicros === row.amount_micros
        ? `Left “${row.name}” at ${before}/day`
        : `${patch.amountMicros > row.amount_micros ? "Raised" : "Lowered"} “${row.name}” ` +
          `from ${before} to ${formatMoney(patch.amountMicros, opts.currencyCode)}/day`;

  return {
    resourceName: resourceNameFor("campaign_budget", opts.customerId, id),
    entry: {
      method: "POST",
      endpoint: opts.endpoint,
      actionType: "budgetUpdate",
      targetType: "campaignBudget",
      targetId: id,
      request: op,
      responseCode: 200,
      summary: money
        ? changes.length
          ? `${money} (${changes.join(", ")})`
          : money
        : `Updated budget “${row.name}”: ${changes.join(", ")}`,
    },
  };
}

function removeBudgetOp(db: Database, op: MutateOperation, opts: MutateOptions, validateOnly: boolean): Applied {
  const id = idFromResourceName(op.remove, "campaignBudget", opts.customerId);
  const row = getBudget(db, id);
  if (!row) throw mutateResourceNotFound(String(op.remove));
  if (budgetIsAttached(db, id)) {
    throw new GoogleAdsError(
      400,
      { campaignBudgetError: "CAMPAIGN_BUDGET_IN_USE" },
      "The campaign budget is associated with at least one campaign, and so the campaign budget cannot be removed.",
      { trigger: String(op.remove) },
    );
  }
  if (!validateOnly) removeBudget(db, id);
  return {
    resourceName: resourceNameFor("campaign_budget", opts.customerId, id),
    entry: {
      method: "POST",
      endpoint: opts.endpoint,
      actionType: "budgetRemove",
      targetType: "campaignBudget",
      targetId: id,
      request: op,
      responseCode: 200,
      summary: `Removed budget “${row.name}”`,
    },
  };
}

function applyOne(db: Database, raw: unknown, index: number, opts: MutateOptions): Applied {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw requestError("OPERATION_REQUIRED", `operations[${index}] must be a JSON object.`);
  }
  const op = raw as MutateOperation;
  const kinds = (["create", "update", "remove"] as const).filter((k) => op[k] !== undefined);
  if (kinds.length !== 1) {
    throw requestError("REQUIRED_FIELD_MISSING", "The request is missing required information.");
  }

  if (kinds[0] === "create") {
    if (opts.resource === "campaign") {
      // MUTATE_NOT_ALLOWED is a real MutateError member and says exactly this:
      // the operation is well-formed and this service will not run it. A code an
      // agent's SDK cannot find in the generated enum is worse than no code.
      throw new GoogleAdsError(
        501,
        { mutateError: "MUTATE_NOT_ALLOWED" },
        "Campaign creation is not implemented in this sandbox. Create a budget and update an existing campaign instead.",
      );
    }
    return createBudgetOp(db, op, opts, opts.validateOnly);
  }
  if (kinds[0] === "remove") {
    return opts.resource === "campaign"
      ? removeCampaignOp(db, op, opts, opts.validateOnly)
      : removeBudgetOp(db, op, opts, opts.validateOnly);
  }
  return opts.resource === "campaign"
    ? updateCampaignOp(db, op, opts, opts.validateOnly)
    : updateBudgetOp(db, op, opts, opts.validateOnly);
}

/**
 * Run the batch. With `partialFailure` false — the default, and what an agent
 * gets if it says nothing — the first failure aborts everything and nothing is
 * written, because the caller runs inside one transaction. With it true, the
 * failed slot becomes `{}` and its error is reported in `partialFailureError`
 * with the operation's index, which is the only way a caller can tell which of
 * ten operations went wrong.
 *
 * `validateOnly` runs every check and writes nothing — and logs nothing, because
 * the audit trail records what the agent changed and a dry run changed nothing.
 * It also answers with NO results: Google's contract for it is "only errors are
 * returned, not results", and a clone that handed back resource names would teach
 * an agent to dry-run and then read `results[0].resourceName`, which is undefined
 * against a real account.
 */
export function applyOperations(db: Database, opts: MutateOptions): MutateOutcome {
  if (!Array.isArray(opts.operations) || opts.operations.length === 0) {
    throw requestError("REQUIRED_FIELD_MISSING", "The request is missing required information.");
  }

  const results: Array<{ resourceName?: string }> = [];
  const entries: ActionEntry[] = [];
  const failures: GoogleAdsErrorItem[] = [];

  opts.operations.forEach((raw, index) => {
    try {
      const applied = applyOne(db, raw, index, opts);
      results.push({ resourceName: applied.resourceName });
      if (!opts.validateOnly) entries.push(applied.entry);
    } catch (err) {
      if (!opts.partialFailure || !(err instanceof GoogleAdsError)) throw err;
      const item = err.toItem();
      item.location = {
        fieldPathElements: [
          { fieldName: "operations", index },
          ...(item.location?.fieldPathElements ?? []),
        ],
      };
      failures.push(item);
      results.push({});
    }
  });

  // A dry run reports only what was wrong, never what would have been — see
  // above. The slots are still filled above so a partial failure can name the
  // index of the operation that failed.
  const reported = opts.validateOnly ? [] : results;

  if (!failures.length) return { results: reported, entries };
  return {
    results: reported,
    entries,
    partialFailureError: {
      // google.rpc.Code.INVALID_ARGUMENT — a partial failure is always a
      // validation failure of the operations that did not apply.
      code: 3,
      message: "Request contains an invalid argument.",
      details: [
        {
          "@type": `type.googleapis.com/google.ads.googleads.${opts.apiVersion}.errors.GoogleAdsFailure`,
          errors: failures,
        },
      ],
    },
  };
}
