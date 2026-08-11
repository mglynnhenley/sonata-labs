# AGENTS.md

Working in the Gmail twin. Read the [root AGENTS.md](../../AGENTS.md) first — it
covers what has gone wrong across the whole repo. This file covers this app.
For usage see [README.md](README.md); for design, [ARCHITECTURE.md](ARCHITECTURE.md).

## What this is

One of Sonata's three clones. A Gmail-shaped REST API the official `googleapis`
SDK drives by overriding `rootUrl`, served over a mutable SQLite copy of a
mailbox, behind a real OAuth2 authorization server. Writes are simulated (local
DB only) and audit-logged; the judge grades that log. Nothing reaches Google.

**This app has no mailbox UI.** The Gmail replica lives in `apps/gmail-ui`
(port 3901) and connects here as a third-party OAuth client. Anything you change
in the read paths, you verify through the API and, if it is user-visible, in that
app.

## Two credentials

Get this wrong and everything 401s or nothing is protected.

- `/gmail/v1/*` — an **OAuth2 access token** minted by this server. `auth.ts`
  validates it against `oauth_tokens` and checks the route's declared scope.
- `/api/sandbox/*` — the **static `SANDBOX_TOKEN`** (`src/lib/sandbox/auth.ts`).
  Control plane only. It is not accepted on `/gmail/v1/*`.

A script or harness needs a real token: `POST /api/sandbox/token` with the admin
token returns one. `src/lib/eval/client.ts` (`obtainAccessToken`,
`connectGmailOAuth`) is the one place that does it — use it rather than a second
implementation.

## Commands

Everything below runs from `apps/gmail`. **`PORT=3101` is not optional**: these
scripts default to 3100, the port the twin used before the monorepo, and a stale
server may well be answering there.

```bash
npm run db:init          # create data/{snapshot,working,audit}.db + seed the dev OAuth clients
npm run db:init -- --force   # drop & recreate working.db
npm run seed             # synthetic 18-message mailbox (snapshot -> working); no Google needed
npm run dev:gmail        # from the REPO ROOT: dev server on :3101

npx tsc --noEmit         # typecheck (fast)
npm test                 # vitest, 234 cases

PORT=3101 npm run smoke          # ACCEPTANCE GATE: official SDK through the real consent flow
PORT=3101 npm run smoke -- reads # part 1 only
PORT=3101 npm run demo           # mini agent: list unread -> read -> label -> archive -> reply
PORT=3101 npm run reset          # restore working.db (curls the server; falls back to a file copy)
npm run sync -- --query "newer_than:90d"   # OPTIONAL real-Gmail read-only sync (needs OAuth creds)
npm run oauth:client -- --name "My Agent" --redirect-uri http://localhost:8080/callback

PORT=3101 npm run eval:check     # eval pipeline check — no API key, no spend
PORT=3101 npm run eval -- --list # scenarios;  --all  --agent naive  --no-judge  --no-reset
npm run judge -- --list          # re-judge saved runs from data/eval-runs/ alone; no server
```

**Definition of done for API changes:** `npx tsc --noEmit` clean, `npm test`
green, `PORT=3101 npm run smoke` all-pass. The smoke uses the real SDK and the
real OAuth handshake — if it passes, agents work against the twin unchanged.

## Environment quirks

- **`PORT` defaults to 3100 in every script here** (`smoke`, `demo`, `reset`,
  `eval`, `src/lib/eval/client.ts`). The twin runs on **3101**. A wrong `PORT`
  does not fail loudly — `reset` will happily reset a different server and
  report success.
- **The repo-root `.env` is not read by these CLIs.** `src/cli/env.ts` calls
  `process.loadEnvFile(cwd/.env)`, and cwd is `apps/gmail`. Export
  `OPENROUTER_API_KEY` in the shell or put it in `apps/gmail/.env`.
- **A reset invalidates every minted access token** — they live in `working.db`.
  Long-running clients must re-mint on 401; `TwinHttp` in `packages/engine` does.
- **A snapshot written by `sync` has no OAuth clients.** `sync` builds from
  `db/schema.sql` alone; `db:init`, `seed` and `reset` are what call
  `seedDevClients`. After a sync, run `reset` — a restart is not enough.
- **Node 25**; `better-sqlite3` compiles from source (works, no prebuilt binary).
- Server holds the working SQLite handle. `src/lib/sandbox/live.ts` notices when
  another process swaps `working.db` underneath it and reopens — but only
  `/api/sandbox/inject` and `/api/sandbox/snapshot` call it. `/gmail/v1/*` uses
  `getDb()`, so after an out-of-process `npm run seed` or `sync` it can serve the
  old inode until one of those routes (or a restart) reopens the handle.
- Never run `next build` while a dev server is up: they fight over `.next`.

## Layout

```
db/schema.sql            single source of truth for all three DBs
src/lib/db.ts            SQLite singleton (working conn with audit.db ATTACHed); open/close
src/lib/store/*          raw-SQL data access (messages, threads, labels, drafts, attachments, outbox, meta)
src/lib/oauth/           the authorization server:
  service.ts             the flow: code issuance, both grants, token validation, admin mint
  store.ts               rows (clients, codes, tokens)      pkce.ts  S256, mandatory
  scopes.ts              Google's real scope strings + the hierarchy between them
  authorize.ts           request validation                 consent.ts  what the screen says
  clients.ts             the well-known dev clients, re-seeded after every reset
src/lib/gmail/           the compatibility layer:
  shape.ts               labelIds overlay + full/metadata/minimal/raw shaping  ← fidelity linchpin
  auth.ts                OAuth token validation + per-route scope check
  mime.ts                RFC822 <-> Gmail payload tree, snippet, base64url helpers
  mutations.ts           message/thread label ops (run inside a tx; bump history)
  errors.ts              Gmail-shaped {error:{code,message,errors,status}} + throwable variants
  route-helpers.ts       handleGmail() wrapper (auth+scope+userId+errors), runMutation() (tx+audit)
  pagination.ts, ids.ts, base64.ts, types.ts
src/lib/sandbox/         the control plane (engine contract):
  auth.ts                SANDBOX_TOKEN gate + BadRequestError
  seed.ts                a whole company at once            inject.ts  one beat
  mail.ts                shared assembly — a beat and a seeded message are the same artifact
  snapshot.ts            the mailbox as the judge sees it, incl. drafts
  live.ts                detects an out-of-process working.db swap (inode check)
src/lib/search/          parse.ts (query->AST) + compile.ts (AST->SQL); backs API q= and the UI
src/lib/send.ts          prepareSend (async) + commitSend/persistPrepared (sync, in tx)
src/lib/drafts-service.ts  draft create/update/send on top of the send pipeline
src/lib/audit.ts         sessions + action_log (writes via ATTACHed audit schema)
src/lib/reset.ts         close working -> swap files -> reopen -> re-seed clients -> new session
src/lib/sync/transform.ts   real Gmail Message -> sandbox row
src/lib/eval/            the single-mailbox triage eval (see below)
src/cli/                 db-init, seed, sync, google-auth, reset, eval, judge, env
app/gmail/v1/users/[userId]/...      the Gmail-compatible API
app/oauth/{authorize,token}          the authorization server's HTTP surface
app/api/{health,activity,sandbox/*,eval/*}   control plane + eval read routes
scripts/                 smoke-sdk(+writes), demo-agent, oauth-register-client, eval-offline-check
tests/                   vitest
```

## Conventions

- **All API routes:** `export const runtime = "nodejs"` and
  `export const dynamic = "force-dynamic"` (better-sqlite3 needs Node; data is
  live). Wrap read handlers in `handleGmail(req, userId, ({db, userId}) => ...)`
  and mutations in `runMutation(db, fn, buildEntry)` so the change + history bump
  + audit row commit atomically.
- **Declare the scope a route needs**, and let `handleGmail` enforce it. A valid
  token missing the scope is Google's `403 insufficientPermissions`, never a 401
  — an agent distinguishes "log in again" from "ask for more" on exactly that.
- **Store functions take `db` as the first arg** (testable with in-memory DBs).
  Route handlers pass `getDb()`.
- **Errors must use `errors.ts`** — return `notFound()`/`badRequest()`/etc.
  (NextResponse) from routes, or throw `notFoundError()`/`GmailError` inside
  mutations/store (translated by `handleGmail`'s catch). Never return a bare 500
  with a non-Gmail shape; gaxios reads `response.data.error.message`.
  Control-plane routes are the exception: `{ok:false,error}`, not Gmail-shaped.
- **base64url everywhere** (`raw`, `body.data`, attachment `data`) via
  `src/lib/gmail/base64.ts`. Standard base64 breaks agents silently.
- **List endpoints return `{id, threadId}` only** — never full messages. Omit
  `nextPageToken` entirely on the last page (never `null`).
- **better-sqlite3 transactions are synchronous.** Do async work (mailparser) in
  a `prepare*` step OUTSIDE the transaction; only sync DB work goes inside
  `db.transaction(...)`. See `send.ts` (prepareSend vs commitSend).
- **labelIds live in `message_labels`, not `raw_json`.** `raw_json` is the
  format=full resource with labelIds stripped; `shape.ts` overlays current labels
  on every read. When writing a message, set labels via the join table.
- **Injected and seeded mail is never audit-logged.** The audit log is the
  agent's record and grading reads it; the world's own moves must stay out.
- **Schema changes:** edit `db/schema.sql` (the single source of truth). The
  audit-table DDL is mirrored in `src/lib/db.ts` (`AUDIT_DDL`) because those
  tables are created against the ATTACHed `audit` alias — keep the two in sync.
  Then `npm run db:init` (every statement is `CREATE TABLE IF NOT EXISTS`).
- **TS/style:** strict TS, `@/*` -> `src/*`. Match surrounding code; keep comments
  explaining *why*, not *what*.

## How to add a Gmail endpoint

1. Add the route file under `app/gmail/v1/users/[userId]/...` mirroring the Gmail
   path. `params` is a `Promise` in Next 15 — `const { userId } = await params`.
2. Read path: `handleGmail(req, userId, ({db}) => json(...))` using a `store/`
   function, declaring the scope it requires. Write path:
   `runMutation(db, () => <mutation>, (result) => <ActionEntry>)`.
3. Shape responses with `shape.ts` / store shapers so fidelity holds.
4. Add a check to `scripts/smoke-sdk.ts` (or `-writes.ts`) exercising it via the
   SDK, and a `tests/` case if there's pure logic (search, mime, pagination).
5. `npx tsc --noEmit`, `npm test`, `PORT=3101 npm run smoke` — all green.

## Working on OAuth

- **PKCE is mandatory and single-use is enforced atomically.** `markAuthCodeUsed`
  is the guard that wins a race; a loser must see "already used", not a second
  token. `tests/oauth.test.ts` covers replay, expiry, cross-client codes, and
  scope narrowing on refresh.
- **Scope hierarchy lives in `scopes.ts` (`SATISFIED_BY`), nowhere else.** A route
  asks for one scope; the table decides which grants satisfy it.
- **Refresh tokens are not rotated** — Google does not rotate on a standard
  refresh, and an agent written against Google will reuse the same one.
- The consent screen is a real page a human reads. If you change what a scope
  grants, change what `consent.ts` says it grants.

## Working on the eval harness

The single-mailbox triage eval predates the episode engine; whole-day scoring
across three twins belongs to `packages/{engine,judge,benchmark}`. Keep new
cross-twin work there rather than growing this.

- **Scenarios declare structure; the model only writes prose.** A scenario lists
  `MessageSlot`s (labels, backdating, threading) and a `brief` per slot;
  `generate/` asks the model for subject+body only and assembles the fixture in
  code. That is why fixtures are deterministic and testable.
- **Prefer deterministic assertions over the judge.** If a claim is checkable from
  the audit log or final labels, write it as an `Assertion` in
  `scenarios/common.ts`. Reserve `judgeQuestion` for what only prose can settle.
- **Only mutations are audit-logged** — reads aren't. So an assertion can only
  observe what the agent *did*. `surfacedPrior` (label-adding) is the history
  signal, not `touchedPrior` (any action): a bulk-archiving agent touches
  everything and must not earn credit for engaging with history.
- **Attribution of audit rows to tool calls is ordinal, not timestamped.** The Nth
  successful mutating call wrote the Nth row; a local archive finishes inside a
  millisecond, so no timestamp rule can separate adjacent calls. That is why
  `ToolCall` carries `error` — a rejected call writes no row and must not
  consume one.
- **`npm run eval:check` is the cheap gate** — inject/observe/grade plus the
  known-bad-control discrimination, zero model calls. Run it after touching
  `observe.ts`, `grade.ts`, or the inject route.
- Traces are written to `data/eval-runs/` by `trace.ts` (ambient capture via
  `AsyncLocalStorage`). The in-app replay panel went with the UI split — the
  `app/api/eval/*` routes that served it currently have no consumer.
- **All model calls go through OpenRouter** (`llm.ts`), which is OpenAI-compatible:
  tools are `{type:'function', function:{...}}`, tool results are `{role:'tool',
  tool_call_id}`, structured output is `response_format.json_schema` with
  `strict: true`. Strict mode requires every object to set
  `additionalProperties: false` and list ALL properties in `required`.
- **Never send sampling params.** Some models reject them outright
  (`openai/gpt-5.4` rejects `temperature`). Depth is controlled with OpenRouter's
  unified `reasoning: {effort}`, which models that lack it simply ignore.
- **Model slugs use dots** (`anthropic/claude-opus-4.8`), not dashes. Don't
  hand-write one from memory —
  `curl -s https://openrouter.ai/api/v1/models | jq -r '.data[].id'`.
- `tests/llm-wire.test.ts` asserts the outgoing request shape against a local
  mock, so wire-format regressions fail with no key and no network.

## Out of scope (return Gmail-shaped 501/404, don't fake)

`history.list` (501; historyId still maintained), `watch`/`stop`, `settings.*`,
`messages.insert/import`, multipart `/batch`, `/upload` media variant. Incremental
historyId-based sync is deferred — re-run `npm run sync`.

## Safety

- Never commit `data/` (all three DBs), `data/credentials.json`, or
  `data/google-token.json` — all gitignored.
- Real Google credentials touch only the sync CLI, never the server runtime. Keep
  it that way: don't import `googleapis`/`google-auth` into `app/` or `src/lib`
  server code (type-only `gmail_v1.Schema$*` imports are fine; `scripts/`,
  `src/cli/sync.ts` and `src/lib/eval/client.ts` are the deliberate exceptions,
  and none of them can reach Google from the server process).
- `POST /api/sandbox/reset` takes **no token** today, unlike the rest of
  `/api/sandbox/*`. Fine on a local port; know it before exposing a twin.
