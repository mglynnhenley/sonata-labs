// Acceptance harness: drive the running sandbox over plain HTTP, exactly the way
// an agent's HTTP client would — only the base URL differs from api.attio.com.
//
//   PORT=3500 npm run smoke
//
// Requires the server to be running on $PORT and a seeded CRM. It resets to the
// snapshot first so it is repeatable, and therefore destroys whatever world is
// currently loaded — never point it at a twin that is mid-episode.
//
// Deliberately NOT driven through the community `attio-js` SDK. That package is
// generated from Attio's OpenAPI spec, which sounds like the perfect conformance
// gate, but the pinned build's spec is stale in ways that have nothing to do
// with this clone: it rejects `sort: completed_at:*` (which the live API
// accepts) and omits `web_url` and a task's `completed_at` entirely. A gate that
// fails on the gate's own bugs is worse than no gate.

const PORT = process.env.PORT || "3500";
const ROOT_URL = process.env.SANDBOX_ROOT_URL || `http://localhost:${PORT}`;
const TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail !== undefined) console.log("      detail:", JSON.stringify(detail)?.slice(0, 300));
  }
}

interface Call {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  token = TOKEN,
): Promise<Call> {
  const res = await fetch(`${ROOT_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

/** Attio's failures are `{status_code, type, code, message}` at the top level. */
async function expectError(
  name: string,
  method: string,
  path: string,
  body: unknown,
  status: number,
  code: string,
  token = TOKEN,
): Promise<Call> {
  const res = await call(method, path, body, token);
  check(
    name,
    res.status === status && res.body.code === code,
    { got: { status: res.status, code: res.body.code }, want: { status, code } },
  );
  return res;
}

type Value = Record<string, unknown>;
type Record_ = { id: Record<string, string>; created_at: string; web_url: string; values: Record<string, Value[]> };

function dataArray(res: Call): Record_[] {
  return (res.body.data ?? []) as Record_[];
}

async function main(): Promise<void> {
  console.log(`\n\x1b[1mAttio sandbox smoke — ${ROOT_URL}\x1b[0m`);

  const reset = await fetch(`${ROOT_URL}/api/sandbox/reset`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sandbox-token": TOKEN },
    body: JSON.stringify({ note: "smoke" }),
  });
  check("reset to snapshot", reset.ok, reset.status);

  // --- reads ---------------------------------------------------------------

  const self = await call("GET", "/v2/self");
  check("self identifies the workspace", self.body.workspace_slug === "acme", self.body);
  check(
    "self carries the five token fields a validating client requires",
    self.body.exp === null &&
      typeof self.body.iat === "number" &&
      typeof self.body.sub === "string" &&
      typeof self.body.aud === "string" &&
      self.body.iss === "attio.com",
    self.body,
  );
  check("self is NOT wrapped in data", !("data" in self.body), Object.keys(self.body));

  const members = await call("GET", "/v2/workspace_members");
  const ownerMemberId = self.body.authorized_by_workspace_member_id as string;
  const owner = (
    members.body.data as Array<{
      id: { workspace_member_id: string };
      email_address: string;
    }>
  ).find((m) => m.id.workspace_member_id === ownerMemberId);
  check("an actor id resolves to a human", owner?.email_address === "sandbox.user@gmail.com", owner);

  const companies = await call("POST", "/v2/objects/companies/records/query", {
    filter: { name: { $contains: "North" } },
  });
  const northwind = dataArray(companies)[0];
  check("records.query finds exactly one Northwind", dataArray(companies).length === 1);
  check("its name value is Northwind", northwind?.values.name[0].value === "Northwind");
  check(
    "its domain carries a derived root_domain",
    northwind?.values.domains[0].root_domain === "northwind.example",
    northwind?.values.domains[0],
  );
  check("its record_id is a v4 UUID", UUID_RE.test(northwind?.id.record_id ?? ""), northwind?.id);
  check(
    "its web_url uses the SINGULAR noun",
    northwind?.web_url === `https://app.attio.com/acme/company/${northwind?.id.record_id}`,
    northwind?.web_url,
  );

  // record_id is a filterable field in Attio's own filtering guide, and $in is
  // how a client re-fetches ids it already holds instead of one GET each.
  const byId = await call("POST", "/v2/objects/companies/records/query", {
    filter: { record_id: { $in: [northwind?.id.record_id] } },
  });
  check(
    "records.query filters on record_id",
    dataArray(byId).length === 1 &&
      dataArray(byId)[0].id.record_id === northwind?.id.record_id,
    byId.body,
  );

  const deals = await call("POST", "/v2/objects/deals/records/query", {
    filter: { stage: "In Progress" },
  });
  const deal = dataArray(deals)[0];
  const dealId = deal?.id.record_id;
  check("a deal filter on a status title resolves", dataArray(deals).length === 1, deals.body);
  check(
    "its stage is the option it names",
    (deal?.values.stage[0].status as Value)?.title === "In Progress",
  );
  check("its stage is the CURRENT value", deal?.values.stage[0].active_until === null);
  check(
    "currency_value is a JSON number",
    deal?.values.value[0].currency_value === 48000,
    deal?.values.value[0],
  );
  check(
    "timestamps carry nine fractional digits",
    /\.\d{9}Z$/.test(deal?.created_at ?? ""),
    deal?.created_at,
  );

  const notes = await call(
    "GET",
    `/v2/notes?parent_object=companies&parent_record_id=${northwind?.id.record_id}`,
  );
  const seededNote = (notes.body.data as Value[])[0];
  check(
    "notes.list finds the escalation note",
    String(seededNote?.title).includes("Escalation"),
    seededNote?.title,
  );
  check("a note carries meeting_id and tags", seededNote?.meeting_id === null && Array.isArray(seededNote?.tags));

  const openTasks = await call(
    "GET",
    `/v2/tasks?linked_object=deals&linked_record_id=${dealId}&is_completed=false`,
  );
  check(
    "tasks.list finds the open follow-up on that deal",
    (openTasks.body.data as Value[])[0]?.content_plaintext === "Send Northwind the renewal quote",
    openTasks.body,
  );
  check(
    "a task has no tags field",
    !("tags" in ((openTasks.body.data as Value[])[0] ?? {})),
    Object.keys((openTasks.body.data as Value[])[0] ?? {}),
  );

  // --- writes --------------------------------------------------------------

  const created = await call("POST", "/v2/objects/companies/records", {
    data: { values: { name: "Smoke Test Ltd", domains: ["smoke-test.example"] } },
  });
  const createdId = (created.body.data as Record_)?.id.record_id;
  check("records.create mints a v4 id", UUID_RE.test(createdId ?? ""), created.body);

  const fetched = await call("GET", `/v2/objects/companies/records/${createdId}`);
  check(
    "records.get round-trips the name",
    (fetched.body.data as Record_)?.values.name[0].value === "Smoke Test Ltd",
  );

  const patched = await call("PATCH", `/v2/objects/deals/records/${dealId}`, {
    data: { values: { stage: "Won 🎉" } },
  });
  const patchedStage = (patched.body.data as Record_)?.values.stage;
  check(
    "records.patch moves the stage",
    (patchedStage?.[0].status as Value)?.title === "Won 🎉",
    patchedStage,
  );
  // The single most important assertion in this file: the new value opened after
  // the record was created, which is only true if the write superseded rather
  // than overwrote.
  check(
    "the new stage value opens later than the record's own created_at",
    Date.parse(String(patchedStage?.[0].active_from)) > Date.parse(deal?.created_at ?? ""),
    { active_from: patchedStage?.[0].active_from, created_at: deal?.created_at },
  );
  const reread = await call("GET", `/v2/objects/deals/records/${dealId}`);
  check(
    "exactly one stage value is active after the move",
    (reread.body.data as Record_)?.values.stage.length === 1,
    (reread.body.data as Record_)?.values.stage,
  );

  const appended = await call("PATCH", `/v2/objects/companies/records/${createdId}`, {
    data: { values: { domains: ["smoke-test.co.example"] } },
  });
  check(
    "PATCH appends a multiselect rather than replacing it",
    (appended.body.data as Record_)?.values.domains.length === 2,
    (appended.body.data as Record_)?.values.domains,
  );

  const note = await call("POST", "/v2/notes", {
    data: {
      parent_object: "deals",
      parent_record_id: dealId,
      title: "Smoke",
      format: "markdown",
      content: "# Heading\nbody",
    },
  });
  const noteBody = note.body.data as Value;
  check("notes.create keeps the markdown", noteBody?.content_markdown === "# Heading\nbody");
  check("notes.create strips markers for the plaintext", noteBody?.content_plaintext === "Heading\nbody");

  const task = await call("POST", "/v2/tasks", {
    data: {
      content: "Smoke follow-up",
      deadline_at: "2026-08-01",
      linked_records: [{ target_object: "deals", target_record_id: dealId }],
      assignees: [{ workspace_member_email_address: "sandbox.user@gmail.com" }],
    },
  });
  const taskBody = task.body.data as Value;
  const taskId = (taskBody?.id as unknown as Record<string, string>)?.task_id;
  check(
    "tasks.create resolves an assignee email to a member id",
    (taskBody?.assignees as Value[])?.[0]?.referenced_actor_id === ownerMemberId,
    taskBody?.assignees,
  );
  check("tasks.create echoes the deadline verbatim", taskBody?.deadline_at === "2026-08-01");

  const completed = await call("PATCH", `/v2/tasks/${taskId}`, {
    data: { is_completed: true },
  });
  check(
    "tasks.update stamps completed_at",
    typeof (completed.body.data as Value)?.completed_at === "string",
    (completed.body.data as Value)?.completed_at,
  );

  const activity = await fetch(`${ROOT_URL}/api/activity`).then(
    (r) => r.json() as Promise<{ actions: Array<{ summary: string }> }>,
  );
  check(
    "the audit trail records the stage transition in words",
    activity.actions.some((a) => /stage: In Progress → Won 🎉/.test(a.summary)),
    activity.actions.map((a) => a.summary).slice(0, 5),
  );

  // --- refusals ------------------------------------------------------------

  await expectError(
    "an unknown object is a 404",
    "POST",
    "/v2/objects/invoices/records/query",
    {},
    404,
    "not_found",
  );
  await expectError(
    "an unknown record id is a 404",
    "GET",
    "/v2/objects/deals/records/00000000-0000-4000-8000-000000000000",
    undefined,
    404,
    "not_found",
  );
  await expectError(
    "an unknown task id is a 404",
    "PATCH",
    "/v2/tasks/00000000-0000-4000-8000-000000000000",
    { data: { is_completed: true } },
    404,
    "not_found",
  );
  const badStage = await expectError(
    "a stage outside the pipeline is a 400 value_not_found",
    "PATCH",
    `/v2/objects/deals/records/${dealId}`,
    { data: { values: { stage: "Closed Won" } } },
    400,
    "value_not_found",
  );
  check(
    "and the message lists every allowed stage",
    ["Lead", "In Progress", "Won 🎉", "Lost"].every((t) =>
      String(badStage.body.message).includes(t),
    ),
    badStage.body.message,
  );
  // Top level, where Attio's spec puts it — a guard that only walks `filter`
  // never sees this one, and the query then answers with every deal.
  await expectError(
    "a top-level filter_view_id is a 400 filter_error",
    "POST",
    "/v2/objects/deals/records/query",
    { filter_view_id: "0f3e3ed6-31b2-4b02-9f74-3a2a0e2f1f10" },
    400,
    "filter_error",
  );
  await expectError(
    "a misspelled top-level key is a 400 rather than the whole object",
    "POST",
    "/v2/objects/deals/records/query",
    { filters: { stage: "Lead" } },
    400,
    "filter_error",
  );
  await expectError(
    "a path filter is a 400 filter_error",
    "POST",
    "/v2/objects/deals/records/query",
    { filter: { path: [["deals", "stage"]], constraints: {} } },
    400,
    "filter_error",
  );
  await expectError(
    "an unknown task sort is a 400 validation_type",
    "GET",
    "/v2/tasks?sort=deadline_at:asc",
    undefined,
    400,
    "validation_type",
  );
  await expectError(
    "PUT on a record is a 501 in Attio's envelope",
    "PUT",
    `/v2/objects/deals/records/${dealId}`,
    {},
    501,
    "not_implemented",
  );
  await expectError(
    "the record upsert is a 501 in Attio's envelope",
    "PUT",
    "/v2/objects/deals/records",
    { data: { values: {} } },
    501,
    "not_implemented",
  );
  // The call an SDK makes straight after tasks.create. Without a handler Next
  // answers it with a bodyless 405 that names no reason.
  await expectError(
    "GET on one task is a 501 in Attio's envelope",
    "GET",
    `/v2/tasks/${taskId}`,
    undefined,
    501,
    "not_implemented",
  );
  await expectError(
    "an unmounted path is a 404 that says what IS mounted",
    "GET",
    "/v2/comments/123",
    undefined,
    404,
    "not_found",
  );
  await expectError(
    "a bad bearer token is a 401",
    "GET",
    "/v2/self",
    undefined,
    401,
    "unauthorized",
    "not-the-sandbox-token",
  );

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("\x1b[31msmoke crashed\x1b[0m", err);
  process.exit(2);
});
