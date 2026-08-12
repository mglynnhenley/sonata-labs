# AGENTS.md

Working in the Google Ads twin. Read the [root AGENTS.md](../../AGENTS.md) first
— it covers what has gone wrong across the whole repo. This file covers this app.
For usage see [README.md](README.md).

## What this is

A Google Ads-shaped REST API over a mutable SQLite copy of one advertiser
account. An agent can pull last week's spend by campaign, find the campaign that
overspent its budget, pause it, and raise or lower a budget — every write
audit-logged and undone by one file copy. Nothing reaches Google; the runtime has
no credentials and could not use them.

**The GAQL parser is the product.** A report clone that answered fixed JSON for a
handful of known query strings would teach an agent nothing, and the first query
it wrote itself would come back silently wrong. `src/lib/googleads/gaql/` parses a
deliberately restricted grammar and compiles it to SQL, and refuses everything
outside that grammar by name with a real error code.

**This app has no UI.** Port 4500 is reserved for a Phase-2 UI and no app is
built against it. It is API-only, exactly like `apps/gmail`.

**It is not an episode twin yet.** `packages/core`'s `TWIN_NAMES` is still three
names wide, so there is no engine adapter, no judge checker, no MCP tool and no
dashboard card. All of that is Phase 2, and none of it lives here — the routes
this clone serves already answer the shared control-plane contracts, so Phase 2 is
an adapter file elsewhere.

## Two credentials

- `/v*/…` — the **static `SANDBOX_TOKEN`** as `Authorization: Bearer`, PLUS a
  non-empty `developer-token` header. The developer token's *value* is not
  checked: the sandbox is not an approval gate, so checking it would be theatre.
  Its *absence* is checked, because a required developer-token is the one thing
  that makes Google Ads' auth different from every other Google API, and an agent
  that learned "a bearer is enough" from the Gmail twin should find that out here
  rather than silently get data back. Its absence is a **400
  `requestError: DEVELOPER_TOKEN_PARAMETER_MISSING`**, not a 401 — that code lives
  in `RequestError`, because an absent header is a malformed request rather than a
  failed identity, and `AuthenticationError` has no `..._PARAMETER_MISSING` member
  to borrow. A bad bearer IS the 401. `login-customer-id` is accepted and ignored
  — the sandbox holds one account, so there is nothing to impersonate.
- `/api/sandbox/*` — the same `SANDBOX_TOKEN`, as `X-Sandbox-Token`, a bearer, or
  `?access_token=`. These routes answer in plain JSON (`{ok:false,error}`), never
  the Google envelope: they are machinery, and dressing them as Google Ads would
  teach an agent that stumbled onto them the wrong thing.

## Commands

Every one of these spells `PORT=3700` out, because a wrong PORT does not fail
loudly — `npm run reset` will happily reset a different twin's server and report
success.

```bash
npm run db:init -w apps/google-ads        # first time, or after a schema change
npm run seed -w apps/google-ads           # the synthetic Acme account
PORT=3700 npm run dev -w apps/google-ads  # the API on :3700
PORT=3700 npm run smoke -w apps/google-ads
npm run test -w apps/google-ads
npm run typecheck -w apps/google-ads
```

## Definition of done, for any API change

`npx tsc --noEmit` clean, `npm test` green, and `PORT=3700 npm run smoke`
all-pass. CI never runs the smoke (no network, no ports), so the acceptance gate
only runs when a human runs it — which is exactly why it is the gate and not the
type checker.

## Environment quirks

- `data/*.db` is gitignored, so pulling a schema change gives you the new
  `db/schema.sql` and none of its tables, and every route then 500s with
  `no such table: X`. `npm run db:init -w apps/google-ads` is safe to re-run:
  every statement in the schema is `IF NOT EXISTS`.
- Node 25 compiles `better-sqlite3` from source. That is a one-time cost, not a
  hang.
- `npm run build` fails while `npm run dev` is running — both write `.next/`.
  `pkill -f "next dev"; rm -rf .next; npm run build`.

## Layout

```
db/schema.sql                  the single source of truth for all three DBs
src/lib/db.ts                  paths, the singleton handle, AUDIT_DDL
src/lib/audit.ts               sessions + action_log, read and write
src/lib/reset.ts               resetWorking / snapshotWorking
src/lib/seed.ts                the synthetic Acme account
src/lib/store/*.ts             raw SQL, one file per table family, db first
src/lib/googleads/
  auth.ts                      the PROVIDER gate
  errors.ts                    the whole Google error envelope, in one file
  ids.ts                       decimal ids, base64url request ids, hex sessions
  dates.ts                     YYYY-MM-DD arithmetic in the account's zone
  resources.ts                 the field catalogue — parser and shaper read it
  shape.ts                     flat SQL row → nested, type-coerced GoogleAdsRow
  pagination.ts                opaque pageToken ⇄ {offset}
  gaql/parse.ts                GAQL → AST
  gaql/execute.ts              AST → validated plan → SQL → rows
  mutate.ts                    the operations executor, updateMask and all
  route-helpers.ts             handleGoogleAds, runMutation, json
src/lib/sandbox/               the CONTROL plane: auth, types, parse, seed,
                               inject, snapshot, live
app/[apiVersion]/…             the provider routes
app/api/…                      health, activity, sandbox
```

## Conventions, each with the failure it prevents

- **`runtime = "nodejs"` and `dynamic = "force-dynamic"` on EVERY route.**
  better-sqlite3 is native and the data is live. A healthy production build lists
  every route as ƒ (Dynamic); an ○ (Static) one serves stale data.
- **Route params are a Promise.** `const { apiVersion } = await ctx.params;`.
- **Every provider route body is wrapped by `handleGoogleAds`.** Nothing in a
  route touches `getDb()` or `checkAuth()` directly, so auth, customer resolution
  and the error envelope cannot drift between endpoints.
- **A mutation and its audit rows commit in one transaction**, one row per
  operation, via `runMutation`. A rolled-back batch leaves no evidence of itself.
- **`AUDIT_DDL` in `src/lib/db.ts` duplicates the audit section of
  `db/schema.sql`** because those tables must be created against the ATTACHed
  `audit.` alias. Change one and you must change the other; nothing catches the
  drift.
- **Store functions take `db` first and write raw SQL.** That is what makes the
  whole data layer testable against `:memory:`.
- **Columns are the source of truth**; `raw_json` is passthrough for the vendor
  fields the sandbox does not reason about, and is layered *under* the columns.
- **int64 crosses the wire as a STRING.** `campaign.id` is `"17204885331"`. This
  is proto3 JSON mapping and it is the single detail agents trip over.
- **Ids are minted in decimal.** An agent must not be able to tell a budget it
  created from one the world seeded.
- **`nextPageToken` is omitted on the last page, never null.** A client looping
  `while (nextPageToken)` on a null would be fine; on `""` it would not, and the
  habit is what matters.
- **Injected and seeded rows are never audit-logged.** The audit log is the
  AGENT's record and the judge reads it to score the agent.
- **Seeds are total, never additive.** An account carrying two companies'
  campaigns is a world no episode described.
- **`world_now_ms`, never `Date.now()`, for anything a report resolves against.**
  Otherwise a seeded LAST_7_DAYS report returns nothing the day after it was
  written. `getWorldNowMs` falling back to the wall clock on an unseeded database
  is the one exception, and it is a read.

## Three decisions this clone made where the existing clones disagree

- **`/api/sandbox/reset` IS token-gated.** Slack's is ungated because its browser
  UI drives it and gmail's followed; this clone ships no UI, so there is no
  tokenless caller to accommodate.
- **`/api/sandbox/snapshot` serves BOTH meanings, and the file says which is
  which.** GET is the judge's capped digest (gmail's and slack's meaning); POST
  promotes working.db to the pristine baseline (calendar's meaning).
- **The control-plane gate lives in `src/lib/sandbox/auth.ts`** and the provider
  gate in `src/lib/googleads/auth.ts`. Calendar keeps both in its provider auth
  file; splitting them makes it impossible to reach for the wrong one by accident.

## Surprising-but-real behaviours worth not "fixing"

- **An unknown customer id is a 401, not a 404.** `CUSTOMER_NOT_FOUND` genuinely
  lives in `AuthenticationError`, because the customer id is part of who you are
  calling as. Same for a customer id with dashes in it, which is a real footgun
  worth surfacing rather than papering over.
- **A `searchStream` error is wrapped in a top-level ARRAY**, exactly like its
  success. A clone that returns a bare object there is the classic bug.
- **A resource with no stats in the window disappears from a metrics query** and
  reappears in an attribute query. That is why the seeded Northwind campaign is
  paused mid-window.
- **A missing mutate target is an HTTP 400 `INVALID_ARGUMENT`**, not a 404. Only
  the API gateway's "Method not found." is a real 404.
- **A metrics-only query still names its resource.** `SELECT metrics.clicks FROM
  campaign` returns `campaign.resourceName` on every row even though the SELECT
  never mentions `campaign`, because the real API always returns the main
  resource's name — and rows of anonymous numbers would be unusable. The
  `fieldMask` does NOT list it, exactly as the real one does not.
- **`validateOnly` returns NO results.** Google's contract is "only errors are
  returned, not results", so a dry run answers `{"results":[]}` and an agent
  cannot learn to read a resource name off one.
- **`totalResultsCount` ignores the query's own `LIMIT`.** That is the field's
  documented definition, which is why `gaql/execute.ts` applies LIMIT in
  TypeScript rather than in SQL — a clipped SELECT cannot report the real count.

## How to add things

- **A field:** one entry in `src/lib/googleads/resources.ts`. The parser starts
  accepting it, the executor knows its column and the shaper emits it under the
  right camelCase path, with no other edit.
- **An endpoint:** one case in the dispatcher at
  `app/[apiVersion]/customers/[customerId]/[method]/route.ts` plus a module under
  `src/lib/googleads/`.

## Out of scope — answer with a provider-shaped 501/404, never fake it

`adGroups:mutate` and `adGroupCriteria:mutate`; `campaigns:mutate` `create` (a
real campaign create needs a channel type, a bidding strategy, network settings
and geo/language criteria — a second design, not a fifth line); `googleAds:mutate`
with temporary resource names; `responseContentType: MUTABLE_RESOURCE`;
`summaryRow`; keyword/search-term/geo/asset resources; `change_event` and
`change_status`; recommendations; OAuth (this clone is static-token today, and if
it ever moves the token route and the re-mint-on-401 contract come with it).

The GAQL grammar is restricted on purpose and each omission is refused by name:
`CONTAINS ANY/ALL/NONE`, `REGEXP_MATCH`, `IS NULL`, the `PARAMETERS` clause, and
the date literals outside TODAY / YESTERDAY / LAST_7_DAYS / LAST_14_DAYS /
LAST_30_DAYS / THIS_MONTH / LAST_MONTH. A deliberately restricted grammar that
says so teaches more than a permissive one that quietly misreads.

## The one place this clone may knowingly differ from the real API

A metrics query with **no date condition at all** sums every stored day. Some
Google surfaces default to a 30-day window instead. The seed makes the two
identical — its stats run exactly 30 days back from the world date — so nothing in
the fixture can tell them apart. If a live call says otherwise it is a one-line
change in `gaql/execute.ts`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
