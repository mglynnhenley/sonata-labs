# Gmail twin

One of the three clones that make up [Sonata Labs](../../README.md) — read the
root README for what the product is and how a scenario runs. This file is about
the Gmail surface only.

It serves a **Gmail-compatible REST API** the official `googleapis` SDK drives by
overriding `rootUrl`, over a mutable copy of a mailbox in SQLite, behind a **real
OAuth2 authorization server**. Every mutation hits the local DB, is recorded in an
audit log the judge reads afterwards, and is undone by one reset. The runtime has
no Google credentials and cannot reach Google.

Two services, because the API is what an agent talks to and the UI is what a
human watches:

| workspace | port | what |
|---|---|---|
| `apps/gmail` | 3101 | the API: `/gmail/v1/*`, `/oauth/*`, `/api/sandbox/*`. No mailbox UI of its own. |
| `apps/gmail-ui` | 3901 | the Gmail-replica web UI + Agent Activity panel. A real third-party OAuth client of the API. |

- **[AGENTS.md](AGENTS.md)** — working in this app: commands, layout, conventions, how to add an endpoint.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the three DBs, request lifecycle, shaping, audit atomicity, send pipeline, OAuth.

## Run it

```bash
npm run dev:gmail                 # from the repo root: API on :3101
npm run db:init -w apps/gmail     # first time, or after a schema change
```

A world normally arrives from the platform (`npm run sonata -- world create …`
POSTs a whole company to `/api/sandbox/seed`). To bring the twin up standalone:

```bash
npm run seed -w apps/gmail        # 18-message synthetic mailbox, no Google account
PORT=3901 npm run dev -w apps/gmail-ui   # then open http://localhost:3901
```

The UI has no token of its own: it redirects you through this server's consent
screen and holds the resulting tokens in a sealed cookie, the way a real client
would.

## Two credentials, and they are not interchangeable

This is the one thing that catches people since the OAuth cutover.

- **`SANDBOX_TOKEN`** (default `sandbox-token`) is the *control-plane admin*
  token. It opens `/api/sandbox/*` — seed, inject, snapshot, mint — and nothing
  else. Presented to `/gmail/v1/*` it earns a Gmail-shaped **401**.
- **`/gmail/v1/*` requires an OAuth2 access token this server minted.** Get one
  the interactive way (`/oauth/authorize` → consent → `/oauth/token`; PKCE S256
  is mandatory), or admin-mint one in a single call:

```bash
TOKEN=$(curl -s -X POST localhost:3101/api/sandbox/token \
  -H 'authorization: Bearer sandbox-token' -H 'content-type: application/json' \
  -d '{}' | jq -r .access_token)

curl -s -H "authorization: Bearer $TOKEN" localhost:3101/gmail/v1/users/me/profile
```

The mint is what the episode engine, the MCP connector and the smoke harness all
use — an operator does not need a consent screen, and one mechanism means an
agent driven by the engine authenticates exactly like an agent plugged in over
MCP.

Scopes are Google's real strings and are enforced per route: a token minted with
`gmail.readonly` gets `403 insufficientPermissions` from `messages.send`, and
`https://mail.google.com/` (the mint default) satisfies everything.

**Access tokens live in `working.db`, so a reset invalidates them.** Anything
long-running must be able to re-mint; that is why the smoke harness re-auths
after its reset check.

## Driving it from an agent

Only `rootUrl` and the token differ from real Gmail:

```ts
import { google } from "googleapis";
const auth = new google.auth.OAuth2();
auth.setCredentials({ access_token: minted }); // from /api/sandbox/token or /oauth/token
const gmail = google.gmail({ version: "v1", auth, rootUrl: "http://localhost:3101" });
await gmail.users.messages.list({ userId: "me", labelIds: ["INBOX"] });
```

> Pass an `OAuth2Client`, not a string — a string `auth` becomes a `?key=` query
> param instead of an `Authorization: Bearer` header, and the call 401s.

Most agents never write this: `packages/mcp` fronts the same routes as MCP tools.

## What the API covers

`/gmail/v1/users/{me|email}/…` — profile, messages
(list/get/send/modify/trash/untrash/delete/batchModify/batchDelete/attachments),
threads, labels CRUD, drafts CRUD + send. Faithful semantics are the point: list
returns `{id, threadId}` only, `nextPageToken` is omitted (not null) on the last
page, TRASH/SPAM are excluded by default, label counts are live, base64url
everywhere.

Deliberately not implemented, and Gmail-shaped about it: `history.list` (501;
historyId numbers are still maintained), `watch`/`stop`, `settings.*`,
`messages.insert/import`, multipart `/batch`, the `/upload` media variant.

## Point it at your real Gmail — optional, read-only, not the normal path

**Nothing in Sonata needs this.** Worlds are generated (`packages/world`) or
seeded synthetically; that is the path everything else assumes. The sync exists
for one case: you want the twin's mailbox to *look like* a specific real one.

It is read-only by construction. The CLI asks for `gmail.readonly` and nothing
else, credentials touch only the CLI, and the server process has no Google auth
at all — there is no code path that writes back to Google.

1. Google Cloud Console: enable the Gmail API, create an OAuth **Desktop app**
   client, download the JSON to `apps/gmail/data/credentials.json` (or set
   `GOOGLE_CREDENTIALS_PATH`).
2. ```bash
   npm run sync -w apps/gmail -- --query "newer_than:90d" --max 1000
   ```
   Options: `--attachment-cap 2` (MB per attachment), `--attachment-budget 100`
   (MB total), `--concurrency 5`. Idempotent — re-run any time.
3. ```bash
   cd apps/gmail && PORT=3101 npm run reset
   ```
   Reset, not just a restart: `sync` rebuilds `snapshot.db` from `db/schema.sql`
   and does not re-seed the OAuth clients, and `reset` is what puts them back —
   skip it and the UI's sign-in fails with an unknown client.

## Reset and the three databases (`data/`, gitignored)

```bash
cd apps/gmail && PORT=3101 npm run reset   # or POST /api/sandbox/reset
```

The CLI curls the running server (only it can safely close and swap the SQLite
handle) and falls back to a file copy when nothing answers — so a wrong `PORT`
resets a different twin and still reports success.

- `snapshot.db` — pristine copy, written only by seed/sync/world-seed.
- `working.db` — what the API serves and mutates. Reset is `copyFileSync(snapshot, working)`; that single line is why two runs are comparable.
- `audit.db` — sessions + action log. A separate file so it survives resets, ATTACHed to the working connection so each mutation + history bump + audit row commits in one transaction.

## Single-mailbox eval

Older than the episode engine and narrower: it drops one hard triage situation
into whatever mailbox is loaded and grades the agent on that alone. Six
scenarios, each built so the right answer needs context the single message does
not carry — `escalation` (2nd angry email, 1st unanswered), `bump`,
`stale-urgency`, `already-resolved`, `passive-aggressive`, `sensitive-personal`.

```bash
cd apps/gmail
PORT=3101 npm run eval:check                        # pipeline check, no API key, no spend
PORT=3101 npm run eval -- --list
PORT=3101 npm run eval -- --scenario escalation
PORT=3101 npm run eval -- --scenario escalation --agent naive   # known-bad control
```

`PORT` is not optional: these scripts still default to **3100**, which is where
the twin lived before the monorepo. Point them at 3101 or they will silently
grade whatever else is listening. `OPENROUTER_API_KEY` must be in the
environment or in `apps/gmail/.env` — the CLIs load `.env` from their own working
directory, so the repo-root `.env` is not read.

Grading is hybrid: deterministic assertions over the audit log and final mailbox
state carry it, and an LLM judge covers only the qualitative residue. The rubric
is checked against `--agent naive`, which archives everything and must fail
`escalation` and `bump` — if it passes, the rubric is broken, not the agent good.

It **costs money**: every scenario except `eval:check` calls OpenRouter for
generation, the agent under test and the judge. Reports and traces land in
`data/eval-runs/` (gitignored). Whole-day scoring across all three twins is the
platform's job, not this — see `packages/{engine,judge,benchmark}`.

## Tests

```bash
npm test -w apps/gmail                     # 234 vitest: OAuth, search, eval generation, judge, traces
cd apps/gmail && PORT=3101 npm run smoke   # the gate: official SDK through the real consent flow
```

If the smoke passes, an agent using `googleapis` works against the twin
unchanged — that is the whole claim, so treat it as the gate. Never run
`next build` while a dev server is up; they fight over `.next`.
