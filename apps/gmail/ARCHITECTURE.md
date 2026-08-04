# Architecture

How the Gmail sandbox fits together. See [AGENTS.md](AGENTS.md) for dev
conventions and [README.md](README.md) for usage.

## Goal & shape

Let an AI agent operate a real-looking mailbox with zero risk to real Gmail. Two
hard rules drive the design:

1. **Read-only from Google.** Real credentials are used only by the sync CLI
   (scope `gmail.readonly`), never by the running sandbox. The server process has
   no Google auth and cannot reach Google.
2. **Faithful enough for the official SDK.** An agent using `googleapis` should
   work by overriding `rootUrl` only. Fidelity is verified by `scripts/smoke-sdk.ts`
   driving the real SDK against the sandbox.

```
 real Gmail ──(gmail.readonly, sync CLI)──► snapshot.db ──copy──► working.db ──► Gmail-compatible API ──► agent (googleapis SDK)
                                                                       │                                        UI (replica) ◄─ /api/ui/*
                                                                       └─ every mutation ──► audit.db (survives reset)
```

## Three databases (`data/`, gitignored)

| DB | Written by | Purpose |
|----|-----------|---------|
| `snapshot.db` | sync / seed CLI | pristine copy; never mutated by the server |
| `working.db`  | the server | what the API serves and mutates |
| `audit.db`    | the server | sessions + action log; **survives resets** |

**Reset** = close the working handle → delete `working.db*` (incl. `-wal`/`-shm`)
→ copy `snapshot.db` → reopen → start a new audit session. It must run in-process
(`POST /api/sandbox/reset`) because the server holds the SQLite handle; the CLI
`reset` curls that endpoint and falls back to a file copy if the server is down.

`db/schema.sql` is the single source of truth, applied identically to all three.
There is **no `threads` table** — a thread is a `GROUP BY thread_id` over
`messages`, so there's nothing to keep consistent under writes.

## The compatibility layer (`src/lib/gmail/`)

The linchpin is **`shape.ts`**. Stored `raw_json` is a format=full Gmail `Message`
resource with `labelIds` **stripped**; `message_labels` is the live source of
truth for labels. Every read overlays current `labelIds` + `historyId`, then
shapes to the requested format:

- `full` — payload with `body.data` (base64url)
- `metadata` — payload headers, body data stripped; honors `metadataHeaders`
- `minimal` — no payload
- `raw` — base64url of stored RFC822; only for sandbox-created messages (else 400)

Get this right and the SDK can't tell the sandbox from real Gmail. Supporting
pieces: `errors.ts` (Gmail-shaped error envelope gaxios understands), `auth.ts`
(static bearer), `pagination.ts` (opaque `pageToken` ⇄ `{offset}`), `mime.ts`
(RFC822 ⇄ payload tree, base64url), `ids.ts` (16-hex ids, `Label_N`).

## Request lifecycle

**Read** (`GET /gmail/v1/users/me/messages/{id}`):
`handleGmail` checks the bearer token and validates `userId` (`me` or the synced
email) → the route calls a `store/` function → `shape.ts` renders the resource →
Gmail-shaped JSON. Errors anywhere become a Gmail error envelope.

**Mutation** (`POST .../modify`, `send`, `trash`, drafts, labels, batch):
wrapped in `runMutation(db, fn, buildEntry)`, which runs one `db.transaction`:
the mailbox change + a `historyId` bump (`bumpMessageHistory`) + an `action_log`
row all commit atomically, or all roll back.

### Audit atomicity across files

The audit lives in a *separate* file so it survives resets, yet the plan wants the
mutation and its audit row in *one* transaction. Both are achieved by `ATTACH`-ing
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

Drafts reuse `persistPrepared`; `drafts.update`/`drafts.send` assign a **new**
message id (Gmail semantics).

## Search (`src/lib/search/`)

`parse.ts` tokenizes the Gmail query (quoted phrases, `field:value`, `-` negation)
into an AST; `compile.ts` turns it into AND-combined SQL over the `messages`
alias: `from`/`to`/`subject` → `LIKE`, `label`/`in`/`is` → `EXISTS` on
`message_labels`, `has:attachment`, date ops (`before`/`after`/`newer_than`/…),
and free text → FTS5 `MATCH` (each term double-quoted to neutralize operators).
Unknown operators degrade to free text — never a 500. The same module backs the
API `q=` param and the UI search box.

## UI (`app/_components/`, `app/api/ui/*`)

A client-rendered Gmail replica (top bar, left rail, message list, thread view)
plus a live **Agent Activity** panel (action feed with expandable request JSON,
outbox, reset button). It polls internal `/api/ui/*` + `/api/activity` JSON routes
every ~3s so agent writes appear live. Those routes read straight from the working
DB (same process, no bearer auth) and return view models from `src/lib/ui/views.ts`.
HTML email bodies render **only inside a sandboxed `<iframe srcDoc>`** — synced
marketing mail is hostile input and never touches the app DOM.

## Sync CLI (`src/cli/sync.ts`)

Loopback OAuth (`@google-cloud/local-auth`, `gmail.readonly` only, token cached at
`data/google-token.json`). Lists message ids for `--query`, fetches
`format=full` at concurrency ~5 with exponential backoff on 429/403, transforms
each (`sync/transform.ts`) into a sandbox row, and fetches attachment bodies under
`--attachment-cap` / `--attachment-budget` (over-cap → metadata only, and
`attachments.get` returns a Gmail-shaped 404). Idempotent: re-running rebuilds
`snapshot.db` for the query, then copies it to `working.db`.

## Verification

- `npm test` — vitest for schema, search (~30 cases), FTS.
- `npm run smoke` — the official `googleapis` SDK pointed at the sandbox; part 1
  reads, part 2 writes + reset + audit survival (48 checks). This is the gate.
- `npm run demo` — the product's actual use case: a mini agent (list unread →
  read → label → archive → reply) observed live in the UI + activity panel.
