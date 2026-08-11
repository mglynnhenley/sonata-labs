# Slack twin

One of the three clones that make up [Sonata Labs](../../README.md) — read the
root README for what the product is and how a scenario runs. This file is about
the Slack surface only.

It mirrors a Slack workspace into SQLite and serves a mutable copy through a
**Slack Web API–compatible** surface, with a Slack-replica UI and a full audit
trail the judge reads afterwards. Nothing leaves the machine.

The design property that matters: **the official `@slack/web-api` SDK talks to
the twin by overriding only the base URL.**

```ts
import { WebClient } from "@slack/web-api";

// The ONLY difference from talking to real Slack.
const client = new WebClient("sandbox-token", {
  slackApiUrl: "http://localhost:3200/api/",
});

await client.chat.postMessage({ channel: "C0ENGINEER1", text: "hello" });
```

Unlike the Gmail twin, this one is still a **single static bearer token**
(`SANDBOX_TOKEN`, default `sandbox-token`) for both the Web API and
`/api/sandbox/*`. Slack's own auth is a workspace token, not an OAuth2 access
token per call, so there is nothing here for the Gmail-style authorization server
to be faithful *to*. See [AGENTS.md](AGENTS.md) for working in this app.

## Run it

```bash
npm run dev:slack               # from the repo root: UI + API on :3200
npm run db:init -w apps/slack   # first time
```

A world normally arrives from the platform (`npm run sonata -- world create …`
POSTs a whole company to `/api/sandbox/seed`). To bring the twin up standalone:

```bash
npm run seed -w apps/slack      # synthetic workspace, no credentials needed

cd apps/slack                   # these scripts read PORT (default 3200)
npm run smoke                   # acceptance checks via the official SDK
npm run demo                    # watch a small agent work, live in the UI
```

Open <http://localhost:3200>, click **Agent activity**, run the demo, and watch
the actions stream in. Then press **Reset to snapshot**.

## Three databases (under `data/`, gitignored)

| DB | Role |
|---|---|
| `snapshot.db` | Pristine capture — written only by `seed` / `sync` / the world seeder. |
| `working.db` | The mutable copy the twin serves. Reset restores it from the snapshot. |
| `audit.db` | `sessions` + `action_log`. **ATTACHed** onto the working connection, so an audit row commits in the same transaction as the mutation — yet survives resets, because it's a separate file. |

All three share one schema (`db/schema.sql`), applied idempotently.

## Data model

Modeled to match the Web API: `users`, `conversations` (channels / DMs / private
groups / mpims), `messages` keyed by **`(channel_id, ts)`** with `thread_ts` for
threading, plus `reactions`, `files` + `message_files`, `pins`, `outbox`, and an
FTS5 index over message text.

`raw_json` stores each resource as Slack would serve it, **minus** the fields the
twin owns live (reactions, thread stats, edits, pin state). Those live in their
own tables and are overlaid on every read — so mutations are always visible and
the resource stays faithful. That overlay (`src/lib/slack/shape.ts`) is the
fidelity linchpin.

## Implemented API surface

`POST /api/<method>` (GET also accepted). Auth: `Authorization: Bearer
sandbox-token`, or a `token` arg.

- **auth**: `auth.test`
- **users**: `list` · `info` · `counts` · `conversations` · `lookupByEmail` ·
  `setPresence` · `getPresence`
- **team / emoji**: `team.info` · `emoji.list`
- **conversations**: `list` · `info` · `history` · `replies` · `members` ·
  `create` · `invite` · `join` · `leave` · `archive` · `unarchive` ·
  `setTopic` · `setPurpose` · `rename` · `open` · `mark`
- **chat**: `postMessage` · `update` · `delete` · `postEphemeral` ·
  `scheduleMessage` · `deleteScheduledMessage` · `scheduledMessages.list` ·
  `getPermalink`
- **reactions**: `add` · `remove` · `get` · `list`
- **pins**: `add` · `remove` · `list`
- **files**: `list` · `info` · `upload` · `getUploadURLExternal` ·
  `completeUploadExternal` (so the SDK's `filesUploadV2` helper works)
- **search**: `messages`

Unknown methods return `{ok:false, error:"unknown_method"}`.

### The five things that differ from a REST/Gmail-shaped API

These are where a wrong mental model silently breaks agents, and what the code
is built around:

1. **Errors are the envelope, not the HTTP status.** Failures are **HTTP 200**
   with `{ok:false, error:"channel_not_found"}`. The SDK throws on `ok:false`
   reading `.data.error` and never looks at the status. One helper
   (`src/lib/slack/envelope.ts`) is used by every method.
2. **Flat method namespace.** `chat.postMessage`, not
   `/channels/{id}/messages` — so one catch-all route
   (`app/api/[method]/route.ts`) dispatches a handler map instead of ~30 nested
   folders.
3. **Bodies are form-encoded *or* JSON.** The SDK switches to JSON when args
   contain `blocks`. `args.ts` merges query + both body types and coerces
   `"true"` / `"42"`.
4. **`ts` is identity, ordering, and cursor** — a monotonic per-channel string
   (`"1699999999.001200"`). Reusing one causes silent client dedupe bugs, so
   `ts.ts` mints `max(now, lastTs + 1µs)` inside the mutation transaction.
5. **Cursor pagination, blank at the end.** `next_cursor` must be empty on the
   last page; echoing a non-empty cursor makes `client.paginate()` loop forever.

Also: **`conversations.history` returns thread roots only** (with
`reply_count` / `latest_reply`); replies come from `conversations.replies`.
Returning replies inline is the canonical clone bug.

## The control plane — `/api/sandbox/*`

How the rest of Sonata drives this twin. Failures here are a plain
`{ok:false,error}`, never a Slack envelope: these routes are machinery, and
dressing them up as Slack would teach a stray agent the wrong thing.

| route | who calls it | `SANDBOX_TOKEN`? |
|---|---|---|
| `/seed` — a whole workspace at once | `packages/world` | required |
| `/inject` — one beat: a message that just landed | `packages/engine` | required |
| `/snapshot` — the workspace as the judge sees it | `packages/judge` | required |
| `/reset` — restore working.db from the snapshot | the CLI, the UI | none |
| `/chaos`, `/events`, `/upload` — the affordances below | you, the UI | none |

The ungated ones are the ones the browser UI drives, and the browser has no
token. Fine on a local port; know it before exposing a twin.

Injected beats are deliberately **not** audit-logged: the audit log is the
agent's record and grading reads it, so the world's own moves stay out.

## Testing affordances

A replica that only ever succeeds is a weak test rig. Two features exist purely
to make agent behaviour observable and falsifiable.

### Fault injection — `POST /api/sandbox/chaos`

Make the twin fail the way Slack fails, and watch how the agent copes. Also
in the UI under **Agent activity**, with one-click presets.

```bash
# 5 calls per minute per method family, Retry-After 5s
curl -X POST localhost:3200/api/sandbox/chaos -H 'content-type: application/json' \
  -d '{"enabled":true,"rateLimit":{"enabled":true,"capacity":5,"windowSec":60,"retryAfterSec":5}}'

# 20% of calls fail; scoped outage on one method; added latency
curl -X POST localhost:3200/api/sandbox/chaos -H 'content-type: application/json' \
  -d '{"enabled":true,"errorRate":0.2,"errorCode":"service_unavailable",
       "failures":{"chat.postMessage":"is_archived"},"latencyMs":600,"jitterMs":400}'

curl -X DELETE localhost:3200/api/sandbox/chaos     # all off
```

Rate limits return a **real HTTP 429 with `Retry-After`** — the one place Slack
doesn't use its `{ok:false}` envelope, and what the SDK's retry logic keys on.
Faults are **deterministic given `seed`**, so a failing agent run reproduces
exactly. Injection happens *before* the handler, so a failed call never writes.

### Events API — `POST /api/sandbox/events`

Event-driven agents need to be *pushed to*. Subscribe a URL and the twin
delivers Slack-shaped, **Slack-signed** events.

```bash
curl -X POST localhost:3200/api/sandbox/events -H 'content-type: application/json' \
  -d '{"url":"http://localhost:4100/slack/events"}'   # runs url_verification first

npx tsx scripts/demo-event-receiver.ts               # a reference receiver
```

Delivered: `message` (plus `message_changed` / `message_deleted` subtypes),
`reaction_added`, `reaction_removed`, `channel_created`,
`member_joined_channel`, `member_left_channel`, `pin_added`, `pin_removed`,
`channel_archive`, `channel_unarchive`.

Each delivery carries `X-Slack-Signature` (`v0=` HMAC-SHA256 over
`v0:timestamp:body`) and `X-Slack-Request-Timestamp`, so receivers can verify
exactly as Slack's docs prescribe — the signing implementation is tested against
Slack's own published example vector. Delivery is fire-and-forget with 3 retries
and exponential backoff: **a broken subscriber can never fail or stall the API
call that produced the event.**

## Unread state

Read cursors are real: `conversations.mark` moves a per-(conversation, user)
cursor, and unread/mention counts are **derived** from it on every read, so they
can't drift. `conversations.info` exposes `unread_count`,
`unread_count_display`, and `last_read`.

Slack's rules are honoured: your own messages never count, thread replies don't
bump the channel badge, channels badge only on mentions (`<@you>`, `@here`,
`@channel`, `@everyone`) while DMs badge everything. The sidebar bolds unread
rows and shows badge counts; opening a channel clears it, and the 3s background
poll deliberately does *not*.

## Search

`search.messages` and the UI share one module (`src/lib/search/`). Supports
`in:#channel` / `in:@user`, `from:@user`,
`has:reaction|file|pin|link`, `before:` / `after:` / `on:` / `during:`, quoted
phrases, `-negation`, and free text via FTS5. Unknown modifiers degrade to free
text — search never throws. Results are always scoped to conversations the
caller can see.

Dates use **UTC** day boundaries: `before:` excludes the named day, `after:`
starts the next day, `on:` / `during:` span the named day / month / year.

## UI

Unlike the Gmail twin, whose replica was split into its own service, this one
serves its UI from the same app: a faithful Slack desktop replica (aubergine
`#3f0e40` sidebar, Lato, 36px avatar gutter, author-grouped messages, reaction
pills, thread facepiles, day dividers) plus a thread drawer, search, and the
**Agent activity** panel. It drives the same public API an agent uses, and polls
internal JSON routes (`/api/ui/*`) every 3s so agent writes appear live.

**Block Kit is rendered**, not flattened to fallback text: `section` (incl.
2-column `fields` and accessories), `header`, `divider`, `context`, `actions`
(with `primary`/`danger` button styles), `image`, and `rich_text`. An
unrecognized block renders as a visible "unrendered block: `type`" marker —
an agent should be able to *see* that something didn't render, not have it
silently disappear.

**Message text is never injected as HTML.** Synced workspace content is hostile
input, so `src/lib/ui/mrkdwn.ts` parses mrkdwn into a token tree that React
renders as text nodes — no `dangerouslySetInnerHTML` anywhere — and it drops
`javascript:` / `data:` URIs. Block Kit text goes through the same renderer.
Covered by `tests/mrkdwn.test.ts`.

## Syncing a real workspace — optional, read-only, not the normal path

**Nothing in Sonata needs this.** Workspaces are generated (`packages/world`) or
seeded synthetically; that is the path everything else assumes. Sync exists for
the case where the twin should resemble one specific real workspace.

```bash
SLACK_TOKEN=xoxp-... npm run sync -w apps/slack
npm run sync -w apps/slack -- --since 30d --max-per-channel 500 --types public_channel,im
npm run sync -w apps/slack -- --no-files
npm run reset -w apps/slack      # load the new snapshot into working.db
```

The token is used **only** by the sync CLI (cached at `data/slack-token.json`,
gitignored); the twin's runtime never sees it and nothing is written back to
Slack. Read-only scopes are enough:

```
users:read channels:read groups:read im:read mpim:read
channels:history groups:history im:history mpim:history
reactions:read files:read pins:read
```

Sync is idempotent (upserts by id / `(channel, ts)`), so re-running doubles as
incremental sync. It backs off on `ratelimited` + `Retry-After`, downloads file
bytes under `--file-cap` (2 MB) and `--file-budget` (100 MB) — over-cap files
keep metadata only — and skips (rather than aborts on) conversations the token
can't read. It is also the one path here never exercised against reality: its arg
handling and auth-failure path are tested, but the happy path is unproven.

## Commands

Run from `apps/slack` unless noted.

```bash
npm run db:init            # create the three DBs
npm run db:init -- --force # drop & recreate working.db
npm run seed               # synthetic workspace → snapshot + working
npm run sync               # real workspace → snapshot (read-only, optional)
npm run reset              # restore working.db from snapshot
npm run dev / build / start   # or `npm run dev:slack` from the repo root
npm run smoke              # official-SDK acceptance (reads, writes, faults, events)
npm run smoke -- reads     # reads only
npm run demo               # the demo agent
npm run events             # reference event receiver (verifies signatures)
npm test                   # vitest
```

## Verification

- `npm test` — **99 unit tests**: seed integrity, ts monotonicity, ~37 search
  cases, mrkdwn (incl. XSS / URI-scheme guards), fault-injection determinism,
  event signing (against Slack's published vector), and unread semantics.
- `npm run smoke` — **152 checks driving the real `@slack/web-api` client**, in
  four parts:
  1. *reads* — pagination terminates, history excludes thread replies, format
     and error codes, workspace metadata.
  2. *writes* — thread bookkeeping, edits, deletes un-threading parents, file
     upload + share, scheduled messages, the audit trail, and reset restoring
     the snapshot while the audit trail survives.
  3. *fault injection* — 429 + `Retry-After` wire shape, SDK recovery, seeded
     reproducibility, per-tier budgets, and that a failed call wrote nothing.
  4. *events* — `url_verification`, signed delivery, every event shape,
     filtering, forged-delivery rejection, and subscriber isolation.

  The harness resets to the snapshot on start, so it is **repeatable** — and so
  running it against a twin mid-episode destroys that episode's world.
- `npm run demo` — an agent doing real work, observable in the UI.

## Stack

Next.js 15 (App Router, Node runtime) · React 19 · TypeScript · Tailwind v4 ·
better-sqlite3 (raw SQL + FTS5) · `@slack/web-api` · vitest.
