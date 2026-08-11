# Sonata Labs

Clone your business, then test how well your agent does the work inside the clone.

Sonata runs a simulated workday against faithful clones of the tools your team
actually uses — Gmail, Slack, Google Calendar — and grades what an agent did
inside them. The clones speak the real providers' API surfaces, so an agent
written against the official SDKs works unchanged: only the base URL moves.

## Quickstart

```bash
git clone https://github.com/mglynnhenley/sonata-labs.git
cd sonata-labs
npm install
npm run dev
```

That brings up every service at once:

| Service | URL | What it is |
|---|---|---|
| Dashboard | http://localhost:3000 | Run episodes, read verdicts |
| Gmail API | http://localhost:3101 | `/gmail/v1/**` behind real OAuth2 |
| Gmail UI | http://localhost:3901 | The mail client, an OAuth client of the API |
| Slack API | http://localhost:3200 | Web API method names, `{ok, error}` envelopes |
| Calendar API | http://localhost:3400 | `/calendar/v3/**` |

## Where the mailbox comes from

A twin needs data. There are two ways to get it, and they are interchangeable:
both write the same `snapshot.db`, so everything downstream behaves identically.

**Synthetic** — a generated company. No accounts, no setup, safe to commit
screenshots of.

```bash
npm run db:init -w apps/gmail   # create the databases
npm run seed -w apps/gmail      # 18 messages, 16 threads, 16 labels
```

**Your real Gmail** — a read-only copy of your actual mailbox, pulled in once
and then operated on locally.

```bash
npm run sync -w apps/gmail -- --query "newer_than:90d" --max 1000
```

This is the only place real Google credentials are ever used, and the scope
requested is `gmail.readonly`. Nothing is written back to Google, ever. The
sandbox runtime never sees your Google token.

One-time setup: create a Desktop OAuth client in Google Cloud with the Gmail API
enabled, download its JSON to `apps/gmail/data/credentials.json` (or point
`GOOGLE_CREDENTIALS_PATH` at it). Without it, `sync` tells you exactly that and
stops.

Re-running `sync` rebuilds the snapshot for the given query. `npm run reset -w
apps/gmail` restores the working mailbox to the snapshot at any point, whichever
source it came from.

Then open http://localhost:3901.

## Pointing an agent at a twin

The Gmail twin is behind a real OAuth2 authorization-code flow, so an agent gets
a token the same way it would from Google. Register a client:

```bash
npm run oauth:client -w apps/gmail -- \
  --name "My Agent" --redirect-uri http://localhost:8080/callback
```

That prints a `client_id` and `client_secret`. The secret is shown once.

Drive the flow at `http://localhost:3101/oauth/authorize` (PKCE with S256 is
required) and exchange the code at `http://localhost:3101/oauth/token`. Then
point the official SDK at the twin — only `rootUrl` changes:

```ts
import { google } from "googleapis";

const auth = new google.auth.OAuth2();
auth.setCredentials({ access_token: token });
const gmail = google.gmail({ version: "v1", auth, rootUrl: "http://localhost:3101" });

await gmail.users.messages.list({ userId: "me", labelIds: ["INBOX"] });
```

Scopes are the real Google strings and are enforced per route: a
`gmail.readonly` token reading the inbox works, and the same token trying to
send gets Google's 403 `insufficientPermissions`.

**Skipping consent.** A benchmark harness is an operator, not an agent, so it
should not click through a consent screen. `POST /api/sandbox/token` mints an
access token directly, gated by the admin token (`SANDBOX_TOKEN`, default
`sandbox-token`). The consent flow exists for realism; this exists for
ergonomics.

```bash
curl -X POST http://localhost:3101/api/sandbox/token \
  -H "Authorization: Bearer sandbox-token" \
  -H "Content-Type: application/json" -d '{}'
```

## Running the services separately

`npm run dev` is the whole stack. Each piece also runs on its own:

```bash
npm run dev:platform      # dashboard only
npm run dev:gmail         # Gmail API + UI together, as one unit
npm run dev:gmail:api     # just the API
npm run dev:gmail:ui      # just the UI
npm run dev:slack
npm run dev:calendar
```

Every twin is standalone: it builds and runs with no orchestrator installed.

## Ports and overrides

Port numbers live in one place, `packages/core/src/ports.ts`. Each twin's UI
sits 800 above its API (3101 → 3901), so the pairing is guessable.

To point a consumer somewhere else, set the URL rather than the port:

```bash
SONATA_GMAIL_URL=http://gmail.internal:8080 npm run episode
```

Both `SONATA_<TWIN>_URL` and `<TWIN>_TWIN_URL` are honoured, with `SONATA_*`
winning if both are set. The two spellings grew up in different packages; they
now resolve identically everywhere, so one variable moves every consumer.

## Tests

```bash
npm test          # every workspace that has a suite
npm run typecheck
```

Neither of those talks to a running server, and every serious defect in this repo
so far has passed the type checker. Two gates do drive the real thing:

```bash
npm run dev:gmail:api                  # in one shell

PORT=3101 npm run smoke -w apps/gmail  # the official SDK, incl. a real OAuth handshake
npm run check:twin                     # the harness against a live twin
```

`smoke` is the twin's own gate: it drives the *official* `googleapis` SDK through
a full authorize → consent → token exchange, then 58 checks over reads, writes,
scope enforcement and consent denial.

`check:twin` is the other direction — the episode engine's `TwinAdapter` contract
against a running twin, and it asserts the property that has broken twice: the
control plane takes the static admin token, `/gmail/v1/**` takes an OAuth token
minted through the bridge, and neither credential works on the other's surface.

## Layout

```
apps/
  platform/    the dashboard: worlds, episodes, verdicts
  gmail/       Gmail API service + OAuth2 authorization server
  gmail-ui/    Gmail web client (an OAuth client of the above, zero DB access)
  slack/       Slack API service
  calendar/    Google Calendar API service
packages/
  core/        contracts: types, ports, the failure-mode catalog. No I/O.
  engine/      runs an episode against the twins over HTTP
  world/       generates and injects a synthetic company
  judge/       grades what the agent did
  mcp/         MCP server fronting the twins
  benchmark/   scoring and aggregation
  scenarios/   authored episodes
  ui/          the design system
```
