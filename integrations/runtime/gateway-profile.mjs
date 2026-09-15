/** Versioned provider-operation costs. This is not a duration per MCP tool. */
export const PROVIDER_TIMING_POLICY = "provider-operations-v1";
export const MAX_BATCH_ITEMS = 1_000;

const SLACK_READS = new Set([
  "auth.test", "users.list", "users.info", "users.counts", "users.conversations", "users.lookupByEmail",
  "users.getPresence", "team.info", "emoji.list", "conversations.list", "conversations.info",
  "conversations.history", "conversations.replies", "conversations.members", "chat.getPermalink",
  "chat.scheduledMessages.list", "reactions.get", "reactions.list", "pins.list", "files.list", "files.info", "search.messages",
]);

export class TimingError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

export function validateTimingPolicy(timing) {
  if (!timing || timing.policy !== PROVIDER_TIMING_POLICY || !Number.isInteger(timing.workUnitsPerTick) ||
      timing.workUnitsPerTick < 1 || timing.workUnitsPerTick > 10_000) {
    throw new Error("A supported provider timing policy and positive workUnitsPerTick are required.");
  }
  return { policy: timing.policy, workUnitsPerTick: timing.workUnitsPerTick };
}

function requestValues(headers, body, query) {
  const type = String(headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  let values = {};
  try {
    if (body.length && type === "application/json") {
      values = JSON.parse(body.toString("utf8"));
      if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error();
    } else if (body.length && type === "application/x-www-form-urlencoded") {
      const form = new URLSearchParams(body.toString("utf8"));
      if ([...form.keys()].some(key => form.getAll(key).length !== 1)) throw new Error();
      values = Object.fromEntries(form);
    } else if (body.length) {
      throw new Error();
    }
    // Batch parameters must have a single interpretation across query and body.
    for (const key of query.keys()) {
      if (query.getAll(key).length !== 1 || key in values) throw new Error();
      values[key] = query.get(key);
    }
  } catch { throw new TimingError("Use an unambiguous JSON or form batch request.", 400); }
  return values;
}

function batchLength(value, { jsonString = false, commaList = false } = {}) {
  try {
    if (jsonString && typeof value === "string") value = JSON.parse(value);
    if (commaList && typeof value === "string") value = value.split(",").filter(Boolean);
  } catch { throw new TimingError("Invalid provider batch.", 400); }
  if (!Array.isArray(value) || !value.length || value.length > MAX_BATCH_ITEMS) {
    throw new TimingError(`Provider batches must contain 1–${MAX_BATCH_ITEMS} items.`, 400);
  }
  return value.length;
}

/** Called only after the gateway's provider route allowlist has accepted a path. */
export function providerOperation(target, method, headers, body) {
  const { twin, pathname, query } = target;
  const operation = `${twin}:${method} ${pathname}`;
  if (twin === "gmail" && pathname === "/oauth/token") {
    return { operation, classification: "maintenance", items: 0, workUnits: 0 };
  }
  const slackMethod = pathname.slice("/api/".length);
  const read = twin === "slack" ? SLACK_READS.has(slackMethod) : method === "GET" ||
    (twin === "calendar" && pathname === "/calendar/v3/freeBusy") ||
    (twin === "attio" && /^\/v2\/objects\/[^/]+\/records\/query$/.test(pathname)) ||
    (twin === "google-ads" && /\/googleAds:(?:search|searchStream)$/.test(pathname));
  if (read) return { operation, classification: "read", items: 1, workUnits: 1 };

  let field;
  let options;
  if (twin === "gmail" && /\/messages\/batch(?:Delete|Modify)$/.test(pathname)) field = "ids";
  if (twin === "google-docs" && /:batchUpdate$/.test(pathname)) field = "requests";
  if (twin === "google-ads" && /:mutate$/.test(pathname)) field = "operations";
  if (twin === "excel" && /\/cells$/.test(pathname)) field = "changes";
  if (twin === "slack" && slackMethod === "files.completeUploadExternal") { field = "files"; options = { jsonString: true }; }
  if (twin === "slack" && ["conversations.invite", "conversations.open"].includes(slackMethod)) {
    // conversations.open also permits an existing channel without a user list.
    const values = requestValues(headers, body, query);
    if (values.users !== undefined) {
      const items = batchLength(values.users, { commaList: true });
      return { operation, classification: "write", items, workUnits: 2 * items };
    }
    if (slackMethod === "conversations.invite") throw new TimingError("A provider invitation needs its users list.", 400);
  }
  const items = field ? batchLength(requestValues(headers, body, query)[field], options) : 1;
  return { operation, classification: "write", items, workUnits: 2 * items };
}
