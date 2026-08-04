# AGENTS.md

Guidance for coding agents (and humans) working in this repo. Read this before
making changes. For product usage, see [README.md](README.md); for design, see
[ARCHITECTURE.md](ARCHITECTURE.md).

## What this is

A local, zero-risk Gmail clone. It syncs real Gmail **read-only** into SQLite,
then serves a **Gmail-compatible REST API** the official `googleapis` SDK drives
by overriding `rootUrl`. All writes are simulated (local DB only) and logged to an
audit trail. Nothing is ever written back to Google.

## Commands

```bash
npm install
npm run db:init          # create data/{snapshot,working,audit}.db from db/schema.sql
npm run seed             # synthetic mailbox (snapshot -> working); no Google needed
PORT=3100 npm start      # run built app (port 3000 is usually taken here — use 3100)
npm run dev              # dev server (also default port 3000; prefer PORT=3100)

npm run build            # production build + typecheck (run before claiming done)
npx tsc --noEmit         # typecheck only (fast)
npm test                 # vitest: schema, search (~30 cases), FTS

PORT=3100 npm run smoke  # ACCEPTANCE GATE: official googleapis SDK, reads+writes+reset (48 checks)
PORT=3100 npm run smoke -- reads   # part 1 only
PORT=3100 npm run demo   # mini agent: list unread -> read -> label -> archive -> reply
npm run sync -- --query "newer_than:90d"   # real Gmail read-only sync (needs OAuth creds)
npm run reset            # restore working.db from snapshot (curls server, falls back to file copy)

PORT=3100 npm run eval:check                 # eval pipeline check — NO API key needed
OPENROUTER_API_KEY=… PORT=3100 npm run eval -- --scenario escalation
PORT=3100 npm run eval -- --list             # scenarios;  --all  --agent naive  --no-judge
PORT=3100 npm run eval -- --scenario bump --model openai/gpt-5.4   # any OpenRouter slug
PORT=3100 npm run eval -- --scenario escalation --no-reset   # keep the mailbox to inspect
```

Every run writes a report and a trace to `data/eval-runs/`. Open the sandbox and hit
**Traces** in the header to replay one step by step (↑/↓ or j/k); selecting a step jumps
the mailbox to the thread it touched, read-only. Pass `--no-reset` when you want the
mailbox left in its post-run state — the default reset restores the snapshot, so the
probe messages a trace refers to will be gone.

**Definition of done for API changes:** `npx tsc --noEmit` clean, `npm test`
green, and `PORT=3100 npm run smoke` at 48/48. The smoke harness uses the real
SDK — if it passes, agents work against the sandbox unchanged. Treat it as the
gate the plan does.

## Environment quirks

- **Port 3000 is usually taken** by another workspace. Always `PORT=3100`. The
  `smoke`/`demo`/`reset` scripts read `PORT` (default 3100).
- **Node 25**; `better-sqlite3` compiles from source (works, no prebuilt binary).
- Server holds the working SQLite handle — a long-lived `npm start` is a
  background process. After changing server code, rebuild + restart to see it
  (`npm run dev` hot-reloads but still needs a non-3000 port).

## Layout

```
db/schema.sql            single source of truth for all three DBs
src/lib/db.ts            SQLite singleton (working conn with audit.db ATTACHed); open/close/reset
src/lib/store/*          raw-SQL data access (messages, threads, labels, drafts, attachments, outbox, meta)
src/lib/gmail/           the compatibility layer:
  shape.ts               labelIds overlay + full/metadata/minimal/raw shaping  ← fidelity linchpin
  mime.ts                RFC822 <-> Gmail payload tree, snippet, base64url helpers
  mutations.ts           message/thread label ops (run inside a tx; bump history)
  errors.ts              Gmail-shaped {error:{code,message,errors,status}} + throwable variants
  auth.ts                static bearer check      pagination.ts  opaque pageToken <-> {offset}
  route-helpers.ts       handleGmail() wrapper (auth+userId+errors) and runMutation() (tx+audit)
  ids.ts, base64.ts, types.ts
src/lib/search/          parse.ts (query->AST) + compile.ts (AST->SQL); shared by API q= and UI
src/lib/send.ts          send pipeline: prepareSend (async) + commitSend/persistPrepared (sync, in tx)
src/lib/audit.ts         sessions + action_log (writes via ATTACHed audit schema)
src/lib/reset.ts         close working -> swap files -> reopen -> new session
src/lib/sync/transform.ts   real Gmail Message -> sandbox row
src/lib/ui/views.ts      view models for the UI JSON routes
src/lib/eval/            triage stress-test eval (data-agnostic):
  types.ts               StressScenario, Fixture/MessageSlot, ProbeOutcome, Assertion, TriageAgent
  scenarios/             common.ts (assertion predicates) + index.ts (the 6-scenario catalog)
  context.ts             read the real mailbox -> MailboxProfile, anchor thread, style exemplars
  generate.ts            few-shot prose per slot; structure/threading assembled in CODE
  agents.ts              TRIAGE_BRIEF, referenceTriageAgent (tool loop), naiveArchiveAgent
  observe.ts             audit log + final state -> ProbeOutcome
  grade.ts               deterministic assertions + LLM judge -> Verdict
  runEval.ts             orchestrator;  report.ts  console + JSON artifact
  llm.ts                 OpenRouter (OpenAI-compatible) client + completeJSON()
  trace.ts               ambient capture of model calls + agent tool calls
  runs.ts                read side of data/eval-runs/ for the API routes
  client.ts              sandbox HTTP + official-SDK Gmail connection
src/cli/                 db-init, seed, sync, google-auth, reset
app/gmail/v1/users/[userId]/...   the Gmail-compatible API (route.ts files)
app/api/{health,activity,sandbox/reset,ui/*,eval/*}   internal routes (no bearer auth)
app/_components/*         Gmail-replica UI (client components)
scripts/                 smoke-sdk(+writes), demo-agent (all use the official SDK)
tests/                   vitest
```

## Conventions

- **All API routes:** `export const runtime = "nodejs"` and
  `export const dynamic = "force-dynamic"` (better-sqlite3 needs Node; data is
  live). Wrap read handlers in `handleGmail(req, userId, ({db, userId}) => ...)`
  and mutations in `runMutation(db, fn, buildEntry)` so the change + history bump
  + audit row commit atomically.
- **Store functions take `db` as the first arg** (testable with in-memory DBs).
  Route handlers pass `getDb()`.
- **Errors must use `errors.ts`** — return `notFound()`/`badRequest()`/etc.
  (NextResponse) from routes, or throw `notFoundError()`/`GmailError` inside
  mutations/store (translated by `handleGmail`'s catch). Never return a bare 500
  with a non-Gmail shape; gaxios reads `response.data.error.message`.
- **base64url everywhere** (`raw`, `body.data`, attachment `data`) via
  `src/lib/gmail/base64.ts` (`Buffer` `'base64url'`). Standard base64 breaks
  agents silently.
- **List endpoints return `{id, threadId}` only** — never full messages. Omit
  `nextPageToken` entirely on the last page (never `null`).
- **better-sqlite3 transactions are synchronous.** Do async work (mailparser) in
  a `prepare*` step OUTSIDE the transaction; only sync DB work goes inside
  `db.transaction(...)`. See `send.ts` (prepareSend vs commitSend).
- **labelIds live in `message_labels`, not `raw_json`.** `raw_json` is the
  format=full resource with labelIds stripped; `shape.ts` overlays current labels
  on every read. When writing a message, set labels via the join table.
- **Schema changes:** edit `db/schema.sql` (the single source of truth). The
  audit-table DDL is mirrored in `src/lib/db.ts` (`AUDIT_DDL`) because those
  tables are created against the ATTACHed `audit` alias — keep the two in sync.
- **TS/style:** strict TS, `@/*` -> `src/*`. Match surrounding code; keep comments
  explaining *why*, not *what*.

## How to add a Gmail endpoint

1. Add the route file under `app/gmail/v1/users/[userId]/...` mirroring the Gmail
   path. `params` is a `Promise` in Next 15 — `const { userId } = await params`.
2. Read path: `handleGmail(req, userId, ({db}) => json(...))` using a `store/`
   function. Write path: `runMutation(db, () => <mutation>, (result) => <ActionEntry>)`.
3. Shape responses with `shape.ts` / store shapers so fidelity holds.
4. Add a check to `scripts/smoke-sdk.ts` (or `-writes.ts`) exercising it via the
   SDK, and a `tests/` case if there's pure logic (search, mime, pagination).
5. `npx tsc --noEmit`, `npm test`, `PORT=3100 npm run smoke` — all green.

## Working on the eval harness

- **Scenarios declare structure; the model only writes prose.** A scenario lists
  `MessageSlot`s (labels, backdating, threading) and a `brief` per slot. `generate.ts`
  asks the model for subject+body only, then assembles the fixture in code. Keep it
  that way — it's why fixtures are deterministic and testable.
- **Prefer deterministic assertions over the judge.** If a claim is checkable from the
  audit log or final labels, write it as an `Assertion` in `scenarios/common.ts`. Reserve
  `judgeQuestion` for things only prose can settle (tone, whether it understood).
- **Only mutations are audit-logged** — reads aren't. So an assertion can only observe
  what the agent *did*. `surfacedPrior` (label-adding) is the history signal, not
  `touchedPrior` (any action) — a bulk-archiving agent touches everything and must not
  earn credit for engaging with history.
- **Traces are how reads become visible.** `trace.ts` captures every model call and agent
  tool call via `AsyncLocalStorage`, so nothing changes signature to opt in and capture is
  inert outside `withTrace`. The judge sees the read log; assertions deliberately do not,
  so the deterministic rubric stays behaviour-only. Pass a `trace` to `runEval` and persist
  it with `writeTrace` — the CLI does both, and the Traces panel replays the artifact.
- **Attribution of audit rows to tool calls is ordinal, not timestamped.** The Nth
  successful mutating call wrote the Nth row; a local archive finishes inside a
  millisecond, so no timestamp rule can separate adjacent calls. That is why `ToolCall`
  carries `error` — a rejected call writes no row and must not consume one.
- **Adding a scenario:** add it to `SCENARIOS` in `scenarios/index.ts` with ≥1 `must`
  assertion and a `judgeQuestion`; the catalog tests enforce slot/threading validity.
  Then confirm `--agent naive` still fails the ones it should.
- **`npm run eval:check` is the cheap gate** — it exercises inject/observe/grade and the
  known-bad-control discrimination with zero model calls. Run it after touching
  `observe.ts`, `grade.ts`, or the inject route.
- Injection is deliberately **not** audit-logged (it's test setup, and the grader reads
  the audit log to judge the agent). Probes carry `is_sandbox_created = 0` so they blend
  in with synced mail.
- **All model calls go through OpenRouter** (`llm.ts`), which is OpenAI-compatible — so
  tools are `{type:'function', function:{...}}`, tool results are `{role:'tool',
  tool_call_id}`, and structured output is `response_format.json_schema` with
  `strict: true`. Strict mode requires every object to set `additionalProperties: false`
  and list ALL properties in `required` — the schemas in `context/generate/grade` already
  do; keep new ones the same or the provider 400s.
- **Never send sampling params.** Some models reject them outright (`openai/gpt-5.4`
  rejects `temperature`). Depth is controlled with OpenRouter's unified
  `reasoning: {effort}`, which models that lack it simply ignore.
- **Model slugs use dots** (`anthropic/claude-opus-4.8`), not dashes. Don't hand-write a
  slug from memory — `curl -s https://openrouter.ai/api/v1/models | jq -r '.data[].id'`.
- `tests/llm-wire.test.ts` asserts the outgoing request shape against a local mock, so
  wire-format regressions fail in CI with no key and no network. Run it after touching
  `llm.ts` or the tool definitions.

## Out of scope (return Gmail-shaped 501/404, don't fake)

`history.list` (501; historyId still maintained), `watch`/`stop`, `settings.*`,
`messages.insert/import`, multipart `/batch`, `/upload` media variant. Incremental
historyId-based sync is deferred — re-run `npm run sync`.

## Safety

- Never commit `data/` (all three DBs), `data/credentials.json`, or
  `data/google-token.json` — all gitignored. Real Google creds touch only the
  sync CLI, never the server runtime.
- The sandbox runtime has no Google credentials and cannot reach Google. Keep it
  that way: don't import `googleapis`/`google-auth` into `app/` or `src/lib`
  server code (type-only `gmail_v1.Schema$*` imports are fine).
