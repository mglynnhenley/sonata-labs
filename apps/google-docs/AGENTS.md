# apps/google-docs — working notes

Read `../../AGENTS.md` first; this file only covers what is specific to this clone.

## What this is

One of Sonata's clones: a Google Docs API v1 surface that the official `googleapis`
SDK drives by overriding `rootUrl`, served over a mutable SQLite copy of a
workspace. Every write is local and audit-logged. It is **not** registered as an
episode twin yet — `TwinName` in `packages/core` is untouched, and registration is
phase 2. Until then port 3600 lives only in this clone's own scripts and docs.

## Two credentials

- `/v1/*` takes the static `SANDBOX_TOKEN` as an OAuth-style bearer, validated in
  `src/lib/docs/auth.ts`. A failure is the Docs envelope, `{error:{code,message,status}}`.
- `/api/sandbox/*` takes the same token but through `src/lib/sandbox/auth.ts`,
  accepts `X-Sandbox-Token` OR a bearer OR `?access_token=`, and answers
  `{ok:false,error}` rather than the Docs envelope — those routes are machinery
  an agent must not learn from.
- `/api/health` needs no credential. `/api/activity` is read-only and ungated: it
  is the evidence, not a lever.

## Commands

Everything from `apps/google-docs`, with `PORT=3600` on every one:

```
npm run db:init            # apply db/schema.sql to snapshot.db, working.db, audit.db
npm run db:init -- --force # drop and recreate working.db
npm run seed               # build the synthetic workspace into snapshot.db, copy to working.db
PORT=3600 npm run dev
npx tsc --noEmit
npm test
PORT=3600 npm run smoke
PORT=3600 npm run reset
```

**Definition of done for API changes:** `npx tsc --noEmit` clean, `npm test` green,
`PORT=3600 npm run smoke` all-pass. The smoke needs a running server and a seeded
workspace, is not part of `npm test`, and CI never runs it — deliberately, since CI
has no ports and no network, which means the acceptance gate only runs when a
human runs it.

## Environment quirks

- `data/*.db` is gitignored, so a fresh checkout or a merged schema change 500s
  with `no such table` until `npm run db:init` (safe: everything is IF NOT EXISTS).
- Node 25 compiles better-sqlite3 from source.
- Never run `next build` while a dev server is up — both write `.next/` and the
  build dies in "Collecting page data".
- `PORT` defaults to 3600 in every script here. A wrong PORT does not fail loudly;
  it talks to a different server and reports success.
- An out-of-process `npm run seed` swaps working.db under the running server.
  `src/lib/sandbox/live.ts` catches it, but only `/api/sandbox/inject` and
  `/api/sandbox/snapshot` call `liveDb()`, so `/v1/*` can serve the old inode until
  one of those routes or a restart reopens the handle.

## Layout

```
db/schema.sql            the single source of truth for all three databases
src/lib/db.ts            paths, the working+audit handle, applySchema
src/lib/audit.ts         sessions and the action log
src/lib/reset.ts         resetWorking / snapshotWorking — file copies, in-process
src/lib/seed.ts          the synthetic demo workspace
src/lib/docs/
  index-space.ts         the flat index space — the hard part
  edit.ts                the five mutations, pure
  batch.ts               the Request dispatcher
  shape.ts               rows -> Document resource — the fidelity linchpin
  defaults.ts            documentStyle and namedStyles, constants not state
  errors.ts              the Docs error envelope, in one file
  auth.ts                the /v1 bearer gate
  ids.ts                 id minting in the vendor's alphabets
  route-helpers.ts       handleDocs, requireDocument, runMutation, splitCustomMethod
src/lib/store/           raw SQL, db first: documents.ts, meta.ts
src/lib/sandbox/         the control plane: auth, types, parse, seed, inject, snapshot, live
src/cli/                 db-init, seed, reset
app/v1/documents/**      documents.create, documents.get, documents.batchUpdate
app/api/**               health, activity, sandbox/{seed,inject,snapshot,reset}
scripts/smoke-sdk.ts     the acceptance gate
tests/                   vitest, in-memory, no server and no mocks
```

## Conventions

Every route file declares `runtime = "nodejs"` and `dynamic = "force-dynamic"`.
`params` is a Promise and is awaited first. Every `/v1` body goes through
`handleDocs`, and every write through `runMutation`, so the change and its audit
row commit in one transaction. Store functions take `db` first. Columns are the
source of truth and `raw_json`/`style_json` are passthrough only. Ids are minted in
the vendor's alphabets. Errors come from `errors.ts` and copy the vendor's wording,
because agents string-match on it. better-sqlite3 transactions are synchronous, so
any async work happens before `db.transaction(...)`. Injected and seeded content is
never audit-logged and everything the agent writes is. Schema changes go to
`db/schema.sql` **and** the `AUDIT_DDL` mirror in `src/lib/db.ts`, which must be
updated by hand — nothing catches the drift.

## The one rule specific to this clone: the index space

Every element carries `startIndex`/`endIndex` in ONE document-wide space, and
`batchUpdate` operates on those numbers. Four invariants, stated in full at the top
of `src/lib/docs/index-space.ts`:

1. Index `[0,1)` is the body's leading section break. It is never stored.
2. Paragraph 0 starts at 1; paragraph k starts at paragraph k−1's `endIndex`.
3. A paragraph's text is its runs concatenated and ALWAYS ends with exactly one
   `"\n"`, counted in its `endIndex`. A blank document is `[0,1)` plus `[1,2)`.
4. Lengths are UTF-16 code units — `String.prototype.length`. An emoji costs two
   indexes. The seed contains one so the rule is exercised outside the tests. The
   index between an emoji's two halves can be named but never acted on: a delete
   that lands there is a 400 and an insert is nudged past the low surrogate, both
   the vendor's behaviour, because half a pair reads back as U+FFFD.

Any new request type must go through `edit.ts`, never touch rows directly, and end
in `normalise` + `shiftNamedRanges` when it changes text.

## A failed batch leaves no audit row

The throw rolls back the transaction the audit row lives in, exactly as it does in
the Gmail and Calendar twins. Do not read the absence as the agent not having
tried. Whether "the agent tried to edit and got a 400" is worth grading is a phase-2
question, and answering it yes means logging failures outside the transaction.

## How to add a request type

1. Add the key to `REQUEST_KEYS` in `batch.ts` and a `case` to `apply`.
2. Implement it as a pure function in `edit.ts`, ending in `normalise` +
   `shiftNamedRanges` if it changes text.
3. Give it a `tests/edit.test.ts` case and, if it returns a payload, a
   `tests/batch.test.ts` reply case.
4. Add a smoke check.
5. tsc, test, smoke.

## Out of scope — return a provider-shaped 501/404, do not fake

Tables (`insertTable` → 501 UNIMPLEMENTED), inline and positioned images, headers,
footers, footnotes, suggestions and suggested changes, lists and bullets, page
breaks, equations, person chips, rich links, multiple tabs (one is modelled, and
`includeTabsContent=true` swaps the response into the `tabs` view — top-level
`body`, `documentStyle`, `namedStyles` and `namedRanges` go unset, as upstream
leaves them), non-empty `segmentId`, text styling requests (`updateTextStyle` and the
rest of the Request union — existing `textStyle` is stored, echoed and inherited on
insert, it is just not mutable through the API in this phase), document permissions
and sharing, revision history, and anything Drive-shaped: listing, searching or
opening a document by name. The real Docs API has no list method and neither does
this clone — agents find documents through links in the Gmail and Slack twins,
which is exactly the intended flow.

Finally: `next dev` appends a `<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
