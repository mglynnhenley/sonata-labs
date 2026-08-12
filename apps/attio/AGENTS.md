# AGENTS.md

Working in the Attio twin. Read the [root AGENTS.md](../../AGENTS.md) first — it
covers what has gone wrong across the whole repo. This file covers this app.
For usage see [README.md](README.md).

## What this is

A standalone Attio-shaped CRM API over a mutable SQLite copy of a workspace.
Writes are simulated (local DB only) and audit-logged; the judge grades that log.
Nothing reaches Attio, and the runtime holds no Attio credential.

The thing to get right here is the **versioned attribute value model**. Every
value is a row in `attribute_values` with `active_from_ms` and `active_until_ms`,
and no write ever updates one in place: a single-value attribute supersedes (the
current row is closed at the instant the new one opens) and a multiselect
attribute appends. That pair is what `active_from`/`active_until` mean on the
wire, and it is why the seed ships a Northwind deal whose stage already has two
rows.

**This app is NOT registered as an episode twin in this phase.** `TwinName` in
`packages/core/src/types/world.ts` is still three names wide, so there is no
engine adapter, no judge route, no dashboard card, and `sonata up` / `sonata
doctor` do not see this clone. Widening that union breaks ~20 exhaustive
`Record<TwinName, X>` maps, which is the point of the union and not a thing to
work around. Phase 2.

**This app has no UI.** Port 4300 is reserved for an Attio replica and nothing is
built there — no `app/page.tsx`, no `app/_components/**`, no `/api/ui/*`, and no
Tailwind toolchain. A UI-projection layer with no UI to project into is a file
that cannot be wrong yet.

## One credential

`SANDBOX_TOKEN` (default `sandbox-token`) gates both surfaces, so the engine
carries one credential for this twin:

- `/v2/*` — `Authorization: Bearer <token>` (or `?access_token=`), checked in
  `src/lib/attio/auth.ts`. A failure is Attio's 401 envelope.
- `/api/sandbox/*` — the same string, accepted as `X-Sandbox-Token`, a bearer or
  `?access_token=` (`src/lib/sandbox/auth.ts`). A failure is a plain
  `{ok: false, error}`, deliberately NOT dressed as Attio: these routes are
  machinery an agent must not learn from.
- `/api/health` takes none. `/api/activity` is read-only and ungated — it is the
  evidence, not a lever.

Attio has no OAuth mode here, so unlike the Gmail twin there is no
`/api/sandbox/token` route and no authorization server. `GET /v2/self` still
returns the OAuth-introspection-shaped body, because that is what the endpoint
returns.

## Commands

`PORT=3500` is spelled out on everything that talks to a server. A wrong `PORT`
does not fail loudly — `reset` will happily reset a different server and report
success.

```bash
npm run db:init -w apps/attio            # create data/{snapshot,working,audit}.db
npm run db:init -w apps/attio -- --force # drop & recreate working.db
npm run seed -w apps/attio               # 9 records / 3 notes / 2 tasks; no Attio account
PORT=3500 npm run dev -w apps/attio      # dev server on :3500

npm run typecheck -w apps/attio          # tsc --noEmit
npm run test -w apps/attio               # vitest, 76 cases, in-memory

PORT=3500 npm run smoke -w apps/attio    # ACCEPTANCE GATE: 45 checks over real HTTP
PORT=3500 npm run reset -w apps/attio    # restore working.db (curls the server, falls back to a copy)
```

**Definition of done for API changes:** `npm run typecheck` clean, `npm test`
green, `PORT=3500 npm run smoke` all-pass. CI never runs the smoke — it needs a
port and a running server — so that gate only fires when a human runs it.

## Environment quirks

- **Node 25**; `better-sqlite3` compiles from source (works, no prebuilt binary).
- **`data/*.db` is gitignored**, so a merged schema change arrives without its
  tables and every route 500s with `no such table: …`. Fix with `npm run db:init
  -w apps/attio` — safe, because every statement in `db/schema.sql` is
  `IF NOT EXISTS`.
- **The smoke resets to the snapshot as its first act**, so it is repeatable and
  therefore destroys whatever world is loaded. Never point it at a twin that is
  mid-episode.
- **Never run `next build` while a dev server is up.** Both write `.next/` and the
  build dies in "Collecting page data". `pkill -f "next dev"; rm -rf .next`.
- The server holds one long-lived SQLite handle. `src/lib/sandbox/live.ts`
  notices when another process swaps `working.db` underneath it and reopens —
  and unlike the Gmail twin, `/v2/*` goes through it too, so an out-of-process
  `npm run seed` cannot leave the API serving an unlinked inode.

## Layout

```
db/schema.sql                  the single source of truth, applied to all three DBs
src/lib/db.ts                  paths, the globalThis handle, AUDIT_DDL
src/lib/audit.ts               sessions + action_log through the ATTACHed alias
src/lib/reset.ts               resetWorking / snapshotWorking
src/lib/seed.ts                the demo world + installStandardSchema (shared with the wire seeder)
src/lib/attio/
  auth.ts                      SANDBOX_TOKEN, the client id, the scope string, the api-token actor
  errors.ts                    Attio's {status_code, type, code, message} envelope
  ids.ts                       v4 UUIDs for resources, hex for audit sessions
  pagination.ts                clampLimit / parseOffset (Attio pages with limit+offset)
  shape.ts                     rows -> Attio resources; the derived fields live here
  values.ts                    the write path: parse every accepted syntax, supersede or append
  filter.ts                    {filter, sorts} -> SQL, and the loud refusals
  task-input.ts                linked_records + assignees, shared by POST and PATCH /v2/tasks
  route-helpers.ts             handleAttio, the require* 404s, renderRecords, runMutation
src/lib/store/*.ts             raw SQL, `db` first, one file per aggregate
src/lib/sandbox/               the control plane: auth, live, types, parse, seed
app/v2/**/route.ts             the Attio API, path-for-path
app/api/{health,activity}      liveness and the audit trail
app/api/sandbox/**             seed / inject / snapshot / reset
tests/                         schema, values, filter, shape, seed — in-memory, no server
scripts/smoke-sdk.ts           the acceptance harness
```

## Conventions

- `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`
  at the top of every route file. `better-sqlite3` is native and the data is live.
- Route `params` is a **Promise**: `const { object } = await params`.
- Store functions take `db` first and hold raw SQL only, which is what makes the
  whole data layer testable against an in-memory database.
- Every /v2 route body goes inside `handleAttio`. Nothing in a route calls
  `getDb()` or `checkAuth()` directly.
- A mutation and its audit row commit in ONE `db.transaction` via `runMutation`,
  so a rolled-back write leaves no evidence behind.
- **The columns are the source of truth.** Anything filterable or sortable lives
  in a typed column on `attribute_values`; `extra_json` carries only the parts no
  filter reaches. Fields Attio infers on read (`email_domain`, `root_domain`,
  `full_name`) are computed at shape time and never stored, because a stored copy
  drifts the first time a value is superseded.
- **Anything the harness writes stays OUT of the audit log; anything the agent
  writes stays IN it.** That single rule is what grading reads. `/api/sandbox/*`
  never calls `logAction`.
- Schema changes go to `db/schema.sql`, and `AUDIT_DDL` in `src/lib/db.ts`
  mirrors the audit section by hand because those tables must be created against
  the ATTACHed alias. Change one and you must change the other; nothing catches
  the drift.
- Attio's 404 wording differs per resource and agents string-match on it:
  objects say `Object with slug/ID "x" not found.` (they accept both), records
  say `Record with ID "x" not found.`, tasks say `Could not find Task with ID
  "x".`. All three live in `route-helpers.ts` and nowhere else.
- Error codes are Attio's, not invented: `filter_error` for a rejected query
  body, `value_not_found` for a record write naming an unknown status option,
  `validation_type` and `not_found` for tasks and notes. The one exception is
  `not_implemented` on a refused verb, which is this sandbox's own and is
  labelled as such in `errors.ts`.

## How to add an endpoint

1. `app/v2/<path>/route.ts` with the two directives and `handleAttio`.
2. A store function in `src/lib/store/` if it needs new SQL.
3. A shape function in `src/lib/attio/shape.ts` if it returns a new resource.
4. `runMutation` with an `ActionEntry` if it writes — and a summary written for a
   person, because the judge reads it.
5. A unit test for the pure part, and a smoke assertion for the HTTP part.
6. Remove the path from the catch-all's `IMPLEMENTED` string in
   `app/v2/[...unmounted]/route.ts`.

## Out of scope

Every one of these answers a provider-shaped 404 or 501 rather than being faked:
objects and attributes CRUD, select-option management, lists and list entries,
`/v2/comments`, `/v2/threads`, `/v2/webhooks`, record upsert, the value-history
endpoint and its `show_historic` param, note and task get/delete, and `PUT` /
`DELETE` on a record. Also out: OAuth, webhooks, events, rate limiting, and any
attribute type outside the eight the writer and the shaper both implement.

Which of those get a 404 and which a 501 is not a taste call: a path nothing
mounts falls to the catch-all's 404, and a verb **Attio's spec declares on a path
this clone does mount** gets `notImplementedRoute`'s 501 — otherwise Next answers
it with a bodyless 405 that names no reason. That rule is why `GET`/`DELETE` on
`/v2/tasks/{task_id}` and `PUT` on `/v2/objects/{object}/records` have handlers
and `GET` on the records collection does not: Attio has no such endpoint, and a
501 saying "not implemented in the sandbox" would teach an agent it exists.

Filter features are refused loudly with a 400 naming them rather than ignored —
`filter_view_id` (which the spec puts BESIDE `filter`, not inside it), any body
key outside the five the spec declares, `path`/`constraints` filters, `path`
sorts, `$not_empty: false`, unknown fields and unknown operators. A filter that
is silently dropped matches everything, and an agent will believe the answer.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
