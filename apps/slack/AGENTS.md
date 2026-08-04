# AGENTS.md

Guidance for coding agents (and humans) working in this repo. Read this before
making changes. For product usage, see [README.md](README.md).

Sibling project: the Gmail sandbox clone in the `edinburgh` workspace, which
this mirrors phase-for-phase. Same architecture, different provider — when in
doubt about a pattern, check how Gmail did it, then check the "Slack is not
Gmail" section below for where it deliberately diverges.

## What this is

A local, zero-risk Slack clone. It syncs a real workspace **read-only** into
SQLite, then serves a **Slack-compatible Web API** the official
`@slack/web-api` SDK drives by overriding `slackApiUrl`. All writes are
simulated (local DB only) and logged to an audit trail. Nothing is ever written
back to Slack.

On top of the replica sit two things that make it a *testing* tool rather than a
mirror: **fault injection** (make it fail the way Slack fails) and a **signed
Events API** (so event-driven agents can run at all).

## Commands

```bash
npm install
npm run db:init            # create data/{snapshot,working,audit}.db from db/schema.sql
npm run db:init -- --force # drop & recreate working.db
npm run seed               # synthetic workspace (snapshot -> working); no Slack needed
PORT=3200 npm run dev      # dev server  (3000 AND 3100 are taken here — use 3200)
PORT=3200 npm start        # run built app

npm run build              # production build + typecheck (run before claiming done)
npx tsc --noEmit           # typecheck only (fast)
npm test                   # vitest: seed, ts, search, mrkdwn, chaos, events, read-state (99)

PORT=3200 npm run smoke            # ACCEPTANCE GATE: official SDK, 152 checks, 4 parts
PORT=3200 npm run smoke -- reads   # part 1 only
PORT=3200 npm run demo             # mini agent: read -> react -> reply in thread -> digest
PORT=3200 npm run events           # reference event receiver (verifies signatures)
npm run sync -- --since 30d        # real workspace read-only sync (needs SLACK_TOKEN)
npm run reset                      # restore working.db from snapshot (curls server, falls back to file copy)
```

**Definition of done for API changes:** `npx tsc --noEmit` clean, `npm test`
green, and `PORT=3200 npm run smoke` at 152/152. The smoke harness drives the
real SDK — if it passes, agents work against the sandbox unchanged. Treat it as
the gate.

The harness **resets to the snapshot on start**, so it is repeatable: run it
twice, get the same number. If you add a check that creates state, you do not
need to clean up, but you must not assume a fresh DB beyond what reset gives you.

## Environment quirks

- **Ports 3000 and 3100 are taken** (3100 is the Gmail sandbox). Always
  `PORT=3200`. The `smoke`/`demo`/`events`/`reset` scripts read `PORT`
  (default 3200).
- **Node 25**; `better-sqlite3` compiles from source (works, no prebuilt binary).
- Server holds the working SQLite handle — a long-lived `npm run dev` is a
  background process. Reset must therefore run **in-process**
  (`POST /api/sandbox/reset`); the CLI curls it and only falls back to a file
  copy when the server is down.
- **`npm run build` fails while `npm run dev` is running.** Both write `.next/`,
  and the build dies in "Collecting page data" with
  `Cannot find module './chunks/vendor-chunks/next.js'`. It is not a code error.
  Stop the dev server and `rm -rf .next` first:
  ```bash
  pkill -f "next dev"; rm -rf .next; npm run build
  ```
  A healthy build lists every `/api/*` route as `ƒ (Dynamic)` — if one shows
  `○ (Static)` it is missing `export const dynamic = "force-dynamic"` and will
  serve stale data.
- `tsx -e "…"` can't use top-level await (CJS). Put throwaway scripts in a
  `.mts` file **inside the project** (module resolution needs `node_modules`).
- The gstack `/browse` skill needs `export PATH="$HOME/.bun/bin:$PATH"`.

## Slack is not Gmail — the five things that bite

These are where a REST/Gmail-shaped mental model silently breaks agents. Most of
the architecture exists to get them right.

1. **Errors are the envelope, not the HTTP status.** Failures are **HTTP 200**
   with `{ok:false, error:"channel_not_found"}`. The SDK throws on `ok:false`
   reading `.data.error` and never inspects the status. The single exception is
   rate limiting: a real **429 with `Retry-After`** (`rateLimited()` in
   `envelope.ts`), which is what the SDK's retry logic keys on.
2. **Flat method namespace.** `chat.postMessage`, not `/channels/{id}/messages`.
   One catch-all route (`app/api/[method]/route.ts`) dispatches the `METHODS`
   map in `src/lib/slack/methods/index.ts`. **Adding a method = adding a map
   entry**, not a folder.
3. **Bodies are form-encoded *or* JSON.** The SDK switches to JSON when args
   contain `blocks`. Always read args through `args.ts` (`str`/`num`/`bool`/
   `clampLimit`), never `req.json()` directly.
4. **`ts` is identity, ordering, and cursor** — a monotonic per-channel string
   `"seconds.micros"`. Mint it **only** via `mintTs(db, channel)` inside the
   mutation transaction. Reusing a ts causes silent client-side dedupe bugs.
5. **Cursor pagination, blank at the end.** `next_cursor` must be empty on the
   last page — echoing a non-empty cursor makes `client.paginate()` loop forever.
   Use `cursorMeta(nextAnchor)`.

Plus the canonical clone bug: **`conversations.history` returns thread roots
only** (with `reply_count`/`latest_reply`); replies come from
`conversations.replies`. Never inline replies into history.

## Layout

```
db/schema.sql              single source of truth for all three DBs
src/lib/db.ts              SQLite singleton (working conn with audit.db ATTACHed); open/close
src/lib/store/*            raw-SQL data access (users, conversations, messages, reactions,
                           pins, files, outbox, meta, read-state)
src/lib/slack/             the compatibility layer:
  envelope.ts              ok()/err()/SlackError + rateLimited()   ← the error model
  shape.ts                 raw_json + live overlays (reactions/threads/edits/pins)  ← fidelity linchpin
  route-helpers.ts         handleSlack() wrapper (args+auth+chaos+errors), runMutation() (tx+audit)
  args.ts                  form-or-JSON arg merging + coercion      auth.ts  static bearer
  cursor.ts                opaque cursor <-> anchor                 ts.ts    monotonic ts minting
  chaos.ts                 fault injection (deterministic, seeded)
  ids.ts, types.ts, emoji-names.ts
  methods/index.ts         THE METHOD REGISTRY — add new methods here
  methods/*.ts             one file per family; `-write.ts` split where a family got big
src/lib/events/            Events API: bus.ts (subscriptions + delivery + retries),
                           events.ts (payload builders), signing.ts (v0 HMAC)
src/lib/search/            parse.ts (query->AST) + compile.ts (AST->SQL); shared by
                           search.messages and the UI
src/lib/audit.ts           sessions + action_log (writes via the ATTACHed audit schema)
src/lib/reset.ts           close working -> swap files -> reopen -> new session
src/lib/sync/transform.ts  real Web API resources -> sandbox rows
src/lib/ui/views.ts        view models for the UI JSON routes (grouping, day dividers, unread)
src/lib/ui/mrkdwn.ts       mrkdwn -> token tree (NEVER HTML)       ← security boundary
src/lib/seed.ts            synthetic workspace (fixed BASE date, reproducible)
src/cli/                   db-init, seed, sync, reset
app/api/[method]/route.ts  the Slack-compatible Web API (one catch-all dispatcher)
app/api/{health,activity,sandbox/{reset,chaos,events,upload},ui/*}   internal routes (no bearer auth)
app/_components/*          Slack-replica UI (client components)
scripts/                   smoke-sdk(+writes,-chaos,-events), demo-agent, demo-event-receiver
tests/                     vitest
```

## Conventions

- **All API routes:** `export const runtime = "nodejs"` and
  `export const dynamic = "force-dynamic"` (better-sqlite3 needs Node; data is
  live). Method handlers are plain `MethodHandler`s registered in the map;
  `handleSlack` already applied args parsing, auth, chaos, and error translation.
- **Mutations go through `runMutation(db, fn, buildEntry)`** so the change and
  the audit row commit in one transaction. `audit.db` is ATTACHed onto the
  working connection specifically to make that atomic while still surviving
  resets (separate file).
- **Store functions take `db` as the first arg** (testable with in-memory DBs).
  Handlers get `db` from the ctx.
- **Errors must use `envelope.ts`** — `throw new SlackError("channel_not_found")`
  inside handlers/stores (translated by `handleSlack`'s catch), or return
  `err(code)`. Use **documented Slack error strings**; inventing codes defeats
  the point. Never return a bare 500 or a non-envelope body.
- **`raw_json` never holds live state.** Reactions, thread stats, edits, and pin
  state live in their own tables and are overlaid by `shape.ts` on every read.
  When storing a message, strip those fields (see `sync/transform.ts`).
- **Thread stats are recomputed, never incremented.** `refreshThreadStats()`
  derives `reply_count`/`reply_users_count`/`latest_reply` from the replies, so
  edits and deletes can't drift them. Deleting the last reply un-threads the
  parent — that's intended, and asserted in smoke.
- **Unread counts are derived, not stored.** `read-state.ts` computes from
  `last_read` + `messages` on every read. Own messages don't count; thread
  replies don't bump the channel badge; channels badge on mentions only, DMs on
  everything.
- **Emit events AFTER the transaction commits**, from the handler — never inside
  `runMutation`. A subscriber must never see an event for a write that rolled
  back. Delivery is fire-and-forget by design: a broken subscriber must not
  fail or stall the API call.
- **better-sqlite3 transactions are synchronous.** Do async work outside
  `db.transaction(...)`; only sync DB work goes inside.
- **better-sqlite3 rejects positional binding with `?N` placeholders.** Use
  named params (`@name`) when a value repeats — see `refreshThreadStats`.
- **Schema changes:** edit `db/schema.sql` (the single source of truth). The
  audit-table DDL is mirrored in `src/lib/db.ts` (`AUDIT_DDL`) because those
  tables are created against the ATTACHed `audit` alias — keep the two in sync,
  then `npm run db:init -- --force && npm run seed`.
- **TS/style:** strict TS, `@/*` -> `src/*`. Match surrounding code; keep
  comments explaining *why*, not *what*.

## How to add a Web API method

1. Write the handler in the right `src/lib/slack/methods/*.ts` family (create a
   `-write.ts` sibling if the family is getting long). Signature is
   `MethodHandler` — you get `{db, args, self, method, httpMethod}`.
2. Read args via `str/num/bool/clampLimit`. Resolve the channel with
   `requireChannel(db, id, self.userId)` (it hides private conversations the
   caller isn't in as `channel_not_found`, matching Slack) and messages with
   `requireMessage`.
3. Mutations: wrap in `runMutation` with a human-readable `summary` — that
   string is what shows up in the activity panel, so write it for a person.
4. **Register it in `METHODS`** (`methods/index.ts`). Unregistered = `unknown_method`.
5. Emit an event if the mutation has one (see `events/events.ts`), after commit.
6. Add a check to `scripts/smoke-sdk.ts` (or `-writes.ts`) exercising it **via
   the SDK**, and a `tests/` case if there's pure logic.
7. `npx tsc --noEmit`, `npm test`, `PORT=3200 npm run smoke` — all green.

## Working on fault injection

- `evaluateChaos()` is called once per API call from `handleSlack`, **after auth
  and before the handler** — so an injected failure provably wrote nothing (smoke
  asserts this).
- **Determinism is the feature.** The PRNG is seeded and advances exactly once
  per evaluated call; `setChaos()` resets the stream. Don't add a code path that
  consumes randomness conditionally, or replays stop lining up.
- Rate limiting is a **token bucket per method family** (`chat.*` separate from
  `conversations.*`), matching Slack's per-tier budgets.
- Rate limit responses must stay a real 429 + `Retry-After`. That is the one
  place the envelope rule is suspended; the SDK depends on it.

## Working on the Events API

- **Signing is the compatibility surface.** `v0=` HMAC-SHA256 over
  `v0:timestamp:rawBody`, sent as `X-Slack-Signature` +
  `X-Slack-Request-Timestamp`. Bolt and anything following Slack's docs will
  *reject* deliveries that get this wrong. `tests/events.test.ts` pins it against
  Slack's own published example vector — keep that test.
- Subscribing runs the **`url_verification` handshake** first; a receiver that
  doesn't echo the challenge is registered inactive with the reason recorded
  rather than silently dropped.
- Delivery: 3 attempts, exponential backoff, never awaited by the request path.
  If you make delivery synchronous you break the isolation guarantee that smoke
  asserts (`unreachable subscriber does not block the API call`).
- Adding an event type: add a builder to `events/events.ts` (don't inline
  payload shapes at call sites), emit after commit, and add a smoke check.

## Security boundaries

- **Message text is never HTML.** `src/lib/ui/mrkdwn.ts` produces a token tree
  that React renders as text nodes. There is no `dangerouslySetInnerHTML`
  anywhere in `app/` — keep it that way. Synced workspace content and
  agent-authored content are both hostile input. `javascript:`/`data:` URIs are
  dropped; `tests/mrkdwn.test.ts` guards this.
- Block Kit text goes through the same renderer (`Blocks.tsx`). An unknown block
  renders a visible "unrendered block" marker — **fail visibly, never silently**.
- Never commit `data/` (all three DBs) or `data/slack-token.json` — gitignored.
  The real token touches only the sync CLI, never the server runtime.
- The sandbox runtime has no Slack credentials and cannot reach Slack. Keep it
  that way: don't import `@slack/web-api` into `app/` or `src/lib` server code
  (type-only imports are fine; `scripts/` and `src/cli/sync.ts` are the
  exceptions that legitimately use the client).

## Out of scope (fail honestly, don't fake)

Socket Mode / RTM, `views.*` (modals), interactive component callbacks,
`apps.*`, admin/enterprise (`admin.*`), workflows/`functions.*`. Unknown methods
return `{ok:false, error:"unknown_method"}`.

`files.uploadV2`'s external flow **is** implemented (getUploadURLExternal ->
byte sink at `/api/sandbox/upload/[fileId]` -> completeUploadExternal), so the
SDK helper works.

Incremental sync is just re-running `npm run sync` (upserts are idempotent).

## Status

Complete and verified: 99 unit tests, 152 SDK acceptance checks (repeatable, and
green against both `npm run dev` and a production `npm start` build).

The one piece never exercised against reality is `npm run sync` — its arg
validation, token handling, and auth-failure path are verified, but it has never
been run against a real workspace. Treat its happy path as unproven.
