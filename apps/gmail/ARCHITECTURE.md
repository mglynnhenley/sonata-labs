# Architecture

How the Gmail twin fits together. See [AGENTS.md](AGENTS.md) for dev conventions,
[README.md](README.md) for usage, and the [root README](../../README.md) for what
Sonata is.

## Goal & shape

Let an agent operate a real-looking mailbox with zero risk to a real one, and
leave behind enough evidence to grade it. Three rules drive the design:

1. **Faithful enough for the official SDK.** An agent using `googleapis` should
   work by overriding `rootUrl` only. Verified by `scripts/smoke-sdk.ts` driving
   the real SDK against the twin.
2. **The provider API is behind real OAuth2.** `/gmail/v1/*` accepts only an
   access token this server minted. The static `SANDBOX_TOKEN` is the
   control-plane credential and is rejected there.
3. **Read-only from Google, always.** Real credentials are used only by the sync
   CLI (scope `gmail.readonly`), never by the running server. The server process
   has no Google auth and cannot reach Google.

```
 real Gmail ──(gmail.readonly, sync CLI, optional)──► snapshot.db
 world seeder ──POST /api/sandbox/seed──────────────► snapshot.db
                                                          │ copy
                                                          ▼
   agent (googleapis SDK / MCP) ──Bearer ya29_…──► /gmail/v1/* ──► working.db
                                                          │
   apps/gmail-ui ──OAuth2 client──► /oauth/* ─────────────┤
                                                          └─ every mutation ──► audit.db (survives reset)
```

The UI lives in a **separate service** (`apps/gmail-ui`, port 3901). This app is
the API only; its `/` is a landing page. The split is what makes the OAuth server
real rather than decorative — the UI has to obtain and refresh tokens the same way
any third-party client would, so the flow is exercised every time a human opens
the mailbox.

## Three databases (`data/`, gitignored)

| DB | Written by | Purpose |
|----|-----------|---------|
| `snapshot.db` | seed / sync / world-seed | pristine copy; never mutated by the server |
| `working.db`  | the server | what the API serves and mutates — mailbox **and OAuth tokens** |
| `audit.db`    | the server | sessions + action log; **survives resets** |

**Reset** = close the working handle → delete `working.db*` (incl. `-wal`/`-shm`)
→ copy `snapshot.db` → reopen → re-seed the well-known OAuth clients → start a new
audit session. It must run in-process (`POST /api/sandbox/reset`) because the
server holds the SQLite handle; the CLI `reset` curls that endpoint and falls back
to a file copy if the server is down.

Two consequences worth internalising: **a reset invalidates every minted access
token** (they live in `working.db`), and **a snapshot written by `sync` carries no
OAuth clients** (`sync` builds from `db/schema.sql` alone) — which is why reset
re-seeds them rather than trusting the snapshot.

`db/schema.sql` is the single source of truth, applied identically to all three.
There is **no `threads` table** — a thread is a `GROUP BY thread_id` over
`messages`, so there's nothing to keep consistent under writes.

## The authorization server (`src/lib/oauth/`, `app/oauth/`)

A real OAuth2 provider, not a stub, because an agent's auth code is part of what
we are testing.

- `authorize.ts` validates the request; `app/oauth/authorize/page.tsx` renders the
  consent screen and `decision/route.ts` mints a single-use code on Allow. The
  POST is re-validated there — a form post is the security boundary and could be
  forged.
- `pkce.ts` — **PKCE S256 is mandatory**; every code carries a challenge.
- `app/oauth/token/route.ts` — `authorization_code` and `refresh_token` grants,
  form-encoded (what `googleapis`' `OAuth2Client` actually POSTs), client
  credentials from body or HTTP Basic. Access tokens live 1h; refresh tokens do
  not expire and are not rotated, matching Google.
- `scopes.ts` holds Google's real scope strings and the hierarchy between them
  (`modify` implies `readonly`, `https://mail.google.com/` implies everything).
  Routes declare what they need; a valid token without it gets Google's
  `403 insufficientPermissions`, not a 401.
- `clients.ts` seeds two well-known clients: the UI (confidential) and
  `sonata-harness` (used only to stamp admin-minted tokens). `scripts/oauth-register-client.ts`
  registers others, writing to snapshot **and** working so they survive a reset.

`POST /api/sandbox/token` is the admin-gated bridge: present `SANDBOX_TOKEN`,
receive a real access token. It exists because the engine and the benchmark are
operators, not agents — making them click consent would be ceremony with no
fidelity payoff — and because an agent developer should be able to get a token in
one call. The interactive flow is for realism; the mint is for ergonomics. They
issue the same kind of token, through the same code path.

## The control plane (`src/lib/sandbox/`, `app/api/sandbox/*`)

The engine's half of the twin contract, gated by `SANDBOX_TOKEN` and answering in
a plain `{ok:false,error}` shape — never a Gmail error envelope, because these
routes are machinery and dressing them as Gmail would teach a stray agent the
wrong thing.

| route | who calls it | what |
|---|---|---|
| `/seed` | `packages/world` | a whole company's mail, at once |
| `/inject` | `packages/engine` | one beat: a message that just arrived |
| `/snapshot` | `packages/judge` | the mailbox as the judge sees it, incl. drafts |
| `/token` | engine, MCP, smoke | mint a provider access token |
| `/reset` | the CLI, the UI | restore working.db from the snapshot |

`mail.ts` is shared by `/seed` and `/inject` so a message injected mid-run is
byte-for-byte the same kind of artifact as one the world was seeded with — an
agent must not be able to tell "arrived during the day" from "was already here".
Neither writes an audit row: the audit log is the *agent's* record and grading
reads it, so the world's own moves stay out.

`live.ts` guards a subtle failure: the server holds one long-lived SQLite handle,
and anything that replaces `working.db` from outside the process (`seed`, `sync`,
a restore by hand) unlinks that file while the open handle goes on serving the
old, now-nameless inode. It stats the file and reopens when the inode changed.

## The compatibility layer (`src/lib/gmail/`)

The linchpin is **`shape.ts`**. Stored `raw_json` is a format=full Gmail `Message`
resource with `labelIds` **stripped**; `message_labels` is the live source of
truth for labels. Every read overlays current `labelIds` + `historyId`, then
shapes to the requested format:

- `full` — payload with `body.data` (base64url)
- `metadata` — payload headers, body data stripped; honors `metadataHeaders`
- `minimal` — no payload
- `raw` — base64url of stored RFC822; only for sandbox-created messages (else 400)

Get this right and the SDK can't tell the twin from real Gmail. Supporting
pieces: `errors.ts` (Gmail-shaped error envelope gaxios understands), `auth.ts`
(OAuth token validation + per-route scope checks), `pagination.ts` (opaque
`pageToken` ⇄ `{offset}`), `mime.ts` (RFC822 ⇄ payload tree, base64url), `ids.ts`
(16-hex ids, `Label_N`).

## Request lifecycle

**Read** (`GET /gmail/v1/users/me/messages/{id}`):
`handleGmail` validates the bearer access token against `oauth_tokens`
(unrevoked, unexpired), checks the route's required scope, and validates `userId`
(`me` or the profile email) → the route calls a `store/` function → `shape.ts`
renders the resource → Gmail-shaped JSON. Errors anywhere become a Gmail error
envelope: 401 for a bad token, 403 for a good token with the wrong scope.

**Mutation** (`POST .../modify`, `send`, `trash`, drafts, labels, batch):
wrapped in `runMutation(db, fn, buildEntry)`, which runs one `db.transaction`:
the mailbox change + a `historyId` bump (`bumpMessageHistory`) + an `action_log`
row all commit atomically, or all roll back.

### Audit atomicity across files

The audit lives in a *separate* file so it survives resets, yet the mutation and
its audit row must be in *one* transaction. Both are achieved by `ATTACH`-ing
`audit.db` onto the working connection (`src/lib/db.ts`). Audit writes go through
the working connection into the `audit.*` schema, so they join the mutation
transaction; the audit file itself is never touched by reset. Because the two
tables are created against the ATTACHed alias, their DDL is mirrored in
`db.ts` (`AUDIT_DDL`) as well as `db/schema.sql`.

## Send pipeline (`src/lib/send.ts`)

better-sqlite3 transactions are synchronous, but parsing RFC822 (mailparser) is
async — so send is split:

1. `prepareSend(raw)` (async, outside the tx): base64url-decode → mailparser →
   build the Gmail payload tree → assign attachment ids.
2. `commitSend(db, prep)` (sync, inside `runMutation`'s tx): resolve the thread
   (explicit `threadId` → `In-Reply-To`/`References` match against stored
   `rfc822_message_id` → else new thread) → insert message with `SENT` →
   write an **outbox** row (the simulated "sent" record — nothing is transmitted)
   → bump history.

`drafts-service.ts` reuses `persistPrepared`; `drafts.update`/`drafts.send` assign
a **new** message id (Gmail semantics).

## Search (`src/lib/search/`)

`parse.ts` tokenizes the Gmail query (quoted phrases, `field:value`, `-` negation)
into an AST; `compile.ts` turns it into AND-combined SQL over the `messages`
alias: `from`/`to`/`subject` → `LIKE`, `label`/`in`/`is` → `EXISTS` on
`message_labels`, `has:attachment`, date ops (`before`/`after`/`newer_than`/…),
and free text → FTS5 `MATCH` (each term double-quoted to neutralize operators).
Unknown operators degrade to free text — never a 500. The same module backs the
API `q=` param and the UI's search box across the service boundary.

## Sync CLI (`src/cli/sync.ts`) — optional

Loopback OAuth (`@google-cloud/local-auth`, `gmail.readonly` only, token cached at
`data/google-token.json`). Lists message ids for `--query`, fetches
`format=full` at concurrency ~5 with exponential backoff on 429/403, transforms
each (`sync/transform.ts`) into a row, and fetches attachment bodies under
`--attachment-cap` / `--attachment-budget` (over-cap → metadata only, and
`attachments.get` returns a Gmail-shaped 404). Idempotent: re-running rebuilds
`snapshot.db` for the query, then copies it to `working.db`.

Nothing else in Sonata depends on it — a generated world reaches the same tables
through `/api/sandbox/seed`. It is here for the case where the mailbox needs to
resemble one specific real inbox.

## Verification

- `npm test` — 234 vitest cases: OAuth (grants, PKCE, scope hierarchy, replay),
  search, schema scaffold, eval generation stages, judge projection and snapshot
  diffing, trace capture, and the OpenRouter wire format.
- `PORT=3101 npm run smoke` — the official `googleapis` SDK pointed at the twin,
  driven through the real PKCE consent handshake; part 1 reads, part 2 writes +
  reset + audit survival. This is the gate.
- `PORT=3101 npm run demo` — a mini agent (list unread → read → label → archive →
  reply), watchable live in `apps/gmail-ui`.
