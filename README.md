# Sonata Labs

Sonata clones a business into a fake Gmail, Slack and Calendar that share one
cast, one backlog and one clock. Your agent works a simulated day inside the
clone, and Sonata scores how much of the job it finished without handing
anything back to a human.

Nothing leaves your machine. The clones are three local Next apps over SQLite
that speak the real vendor APIs, so the agent you already have — the official
`googleapis` and `@slack/web-api` SDKs, or an MCP client — works against them
with nothing changed but a base URL.

## The loop

**1. Connect your agent.** One stdio MCP server fronts all three clones: 28
tools, `gmail_*` / `slack_*` / `calendar_*` plus `sonata_whats_new`, which
answers "what changed since I last looked" across all three surfaces.

```bash
node_modules/.bin/sonata-mcp connect   # prints the config to paste
```

No MCP is fine too — the same command prints the base URLs, the tokens and a
working `curl` for each clone; every tool is a thin call onto those routes.

**2. Describe a business.** One sentence becomes a company: a cast with names,
roles and voices, an inbox with weeks of history behind it, Slack channels with
the argument already in progress, and a calendar with the double-booking already
made. Or clone one of the five that ship with the product and skip the model
call.

```bash
npm run sonata -- world create "a 30-person support desk mid-migration"
npm run sonata -- world template client-escalation
```

**3. Run a day and read the report.** The clock ticks in 15 simulated minutes.
Scripted beats land on schedule whether or not the agent is looking, a director
answers what it does, and every action it takes is audit-logged by the clones.
At the end a deterministic checklist decides the facts ("did it reply to the
escalation before the review?") and a judge reads the day back for the twenty
catalogued failure modes.

```bash
npm run sonata -- run client-escalation --model anthropic/claude-haiku-4.5 --ticks 4
```

The same three steps are the dashboard's three pages; the `run` command calls
the function the Start button calls, so a terminal and a browser cannot
disagree.

## Quickstart

From a clean clone. Node >= 22 (see [Requirements](#requirements)).

```bash
npm install                  # workspaces, native modules, the CLI
npm run sonata -- init       # writes .env, applies each clone's schema
npm run sonata -- up         # dashboard :3000, and the three clones
```

Every Sonata command below is `npm run sonata -- <command>`: it runs this
repo's own CLI, `packages/cli/bin/sonata.mjs`, by path — so it means the same
thing in the first minute of a clone as in the thousandth, on any machine.

`init` asks for an OpenRouter key and accepts an empty answer — everything except
the model calls works without one. It also applies the clones' schemas, which a
clone needs: `data/*.db` is gitignored, so a fresh checkout arrives with three
`db/schema.sql` files and no tables. Every statement is
`CREATE TABLE IF NOT EXISTS`, so `init` is safe to re-run.

Open <http://localhost:3000>, pick a day, press Start. Your key goes in Settings
or in `.env`; Settings wins.

When something is off — a clone answering 500 after a merge, a key nothing reads,
a port already taken — ask rather than guess:

```bash
npm run sonata -- doctor
```

It reads and changes nothing, and every line that is not `ok` carries the command
that clears it. The one that earns the command: a clone's `data/*.db` behind its
committed `db/schema.sql` presents as a 500 on every call and reads like a broken
server. Doctor names the missing tables and the one line that adds them.

The terminal path is the same product:

```bash
npm run sonata -- status                # clones, models, recent runs
npm run sonata -- world list            # what you have cloned, and what ships
npm run sonata -- run client-escalation --ticks 4
```

## Where the mailbox comes from

A clone needs data, and there are two ways to get it. They are interchangeable:
both write the same `snapshot.db`, so nothing downstream can tell which you used,
and `npm run reset -w apps/gmail` restores from whichever it was.

**Synthetic** — a generated company. No accounts, no setup, safe to screenshot.
This is what `sonata world` and the dashboard's Companies page produce, and for
Gmail alone there is also a fixture mailbox:

```bash
npm run seed -w apps/gmail      # 18 messages, 16 threads, 16 labels
```

**Your own Gmail** — a read-only copy of your real mailbox, pulled in once and
then operated on locally.

```bash
npm run sync -w apps/gmail -- --query "newer_than:90d" --max 1000
```

This is the only place real Google credentials are ever used, the scope requested
is `gmail.readonly`, and nothing is written back to Google. The clone's runtime
never sees your Google token — the sync CLI holds it and nothing else does.

One-time setup: create a Desktop OAuth client in Google Cloud with the Gmail API
enabled and download its JSON to `apps/gmail/data/credentials.json`, or point
`GOOGLE_CREDENTIALS_PATH` at it. Without it `sync` says exactly that and stops.

## One real example

This went in:

> Tidewater Kayak Tours, a nine-person coastal kayak rental and guided-tour
> outfit in Rockport, Maine. Today a storm warning forces cancellations across
> the morning tours, and the booking system has double-booked two guides for the
> same trip.

Out came a company of seven named people with voices — Sam Chen the owner,
Rachel on bookings, three guides, a tourism partner at the harbour inn, one
customer — spread across all three clones:

| Surface | What was waiting in it |
| --- | --- |
| Gmail | Rachel's 08:15 thread about the double-book and the cancellations, and Tom Harker asking to rebook the 11:00 group of six |
| Slack | `#ops`, `#booking-alerts`, `#guides` — Gina Marsden asking in `#booking-alerts` whether the afternoon is still running, because her guests are asking |
| Calendar | the 14:30 Seal Island trip that survived the weather, with two guides assigned to it |

And a day to run: **Storm Break**, 12 ticks — 09:00 to 12:00 on the company's
own clock. Claude Haiku 4.5 worked it and came back with this (3 of the 7
checklist rows, 3 of the 6 findings):

```
  run_msmcemkw_atar
  FAIL · score 57% · autonomy 79% · $0.60 · 5m 12s

  What the day asked for
    FAIL  must   Rachel Paulson's email thread about the double-book and cancellations receives a reply from Sam Chen.
          no reply landed on beat ref "b_alert" (4bb29cba88391748)
    PASS  must   Sam Chen sends Tom Harker an email addressing his reschedule request.
          sent to tom.harker@tidewaterkayaktours.com: [audit 9962] POST /gmail/v1/users/me/messages/send …
    FAIL  must   Sam Chen explicitly designates one guide (not both) as lead for the 14:30 Seal Island trip …
          "Marcus is lead" appears in none of the 15 thing(s) the agent wrote on slack

  What the judge found
    critical  ignored-probe (t4)
              Deterministic check [FAIL] gmail c1: "Rachel Paulson's email thread …"
    major     date-blind (t4)
              The agent repeatedly treated the day as Aug 9 while the timeline is
              Aug 7 and used that to dismiss active emails as "old/stale" …
    major     cross-surface-inconsistency (t8)
```

It de-conflicted the guides in the end. It never answered the one person who had
to make phone calls. That gap is the product: the day is only solvable by
reading two surfaces against each other, so an agent that reads one comes back
looking busy and leaves a customer uncalled.

Every line above is read back off `run_msmcemkw_atar.json` — the same artifact
the Results page renders, evidence included, so a number on a page can always be
opened onto the rows that produced it. It is not in this repo: runs live in
`apps/platform/data/runs`, which is gitignored, because a run is yours and about
your agent. Tidewater was generated from that one paragraph, so your version of
this day will have a different cast and a different verdict.

## Ports

| Port | App | What it is |
| --- | --- | --- |
| 3000 | `apps/platform` | the dashboard, and the commands `sonata` fronts |
| 3101 | `apps/gmail` | Gmail clone — Gmail API v1, `/gmail/v1/users/me/…` |
| 3200 | `apps/slack` | Slack clone — Slack Web API, `/api/…` |
| 3400 | `apps/calendar` | Calendar clone — Google Calendar v3, `/calendar/v3/…` |
| 3901 | `apps/gmail-ui` | the Gmail front end, as a real third-party OAuth client |
| 3500 | `apps/attio` | Attio clone — Attio API v2, `/v2/objects/…` |
| 3600 | `apps/google-docs` | Google Docs clone — Docs API v1, `/v1/documents/…` |
| 3700 | `apps/google-ads` | Google Ads clone — GAQL search and mutate, `/v17/customers/…` |
| 3800 | `apps/linkedin` | LinkedIn clone — Posts and social actions, `/rest/…` |

`npm run dev` brings up the first five at once. Each also runs alone:

```bash
npm run dev:platform      # dashboard only
npm run dev:gmail         # the Gmail API and its front end, as one unit
npm run dev:gmail:api     # just the API
npm run dev:gmail:ui      # just the front end
npm run dev:slack
npm run dev:calendar
```

### The other four clones

Attio, Google Docs, Google Ads and LinkedIn are API clones with the same
insides as the three above — the same control plane, the same audit trail, the
same seed and reset — but they are **not yet episode twins**. An agent can call
them directly, and `npm run dev:attio`, `dev:google-docs`, `dev:google-ads` and
`dev:linkedin` each start one; the engine, the judge and the dashboard's twin
strip do not know about them yet, so their absence there is the current state
and not a fault. Wiring them in means widening `TwinName`, which is referenced
in 58 files behind twenty exhaustive maps — worth doing deliberately, and not
as a side effect of adding a fourth surface.

The dashboard starts the clones itself when a run needs them, and `sonata up`
goes through the same scripts, so the Gmail front end comes up with its API
either way. Each single-service script defaults to the port in the table and
yields to an outer `PORT=`, which is what a second checkout on the same machine
needs. The multi-service scripts (`dev`, `dev:gmail`) ignore an outer `PORT` —
one value cannot bind five services.

### Two credentials, and when they are interchangeable

`SANDBOX_TOKEN` (default `sandbox-token`) is the **control-plane admin** token.
It opens `/api/sandbox/*` on all three clones — seed, inject, snapshot, reset,
mint — and it is Slack's and Calendar's API token as well. It is a seatbelt, not
a lock.

Gmail also carries its own OAuth2 server, and `SANDBOX_AUTH` decides whether it
gates `/gmail/v1/*`. The default is `token`: the admin token works there too,
full scope, zero setup. Set `SANDBOX_AUTH=oauth` and `/gmail/v1/*` takes only an
access token that server minted — the admin token earns a Gmail-shaped 401, and
per-route scopes are enforced. The OAuth endpoints (authorize, consent, token,
the mint bridge below) are mounted in both modes, so the flow is always there to
exercise; the mode only changes what the provider API accepts. `/api/health`
reports the active mode.

In `oauth` mode, mint a token in a single call:

```bash
# Slack and Calendar: the admin token is the API token.
curl -s -H "Authorization: Bearer sandbox-token" \
  "http://localhost:3200/api/conversations.list"

# Gmail: mint first, then call.
TOKEN=$(curl -s -X POST http://localhost:3101/api/sandbox/token \
  -H "Authorization: Bearer sandbox-token" -H "Content-Type: application/json" \
  -d '{}' | jq -r .access_token)

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3101/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=10"
```

The MCP server, the episode engine and the smoke harness all mint the same way,
so an agent you plug in authenticates exactly as the benchmark's does. The
interactive route — `/oauth/authorize` → consent → `/oauth/token`, PKCE S256 —
is there too, and is what `apps/gmail-ui` uses; see
[apps/gmail](apps/gmail/README.md).

## What runs cost

Real money, on your OpenRouter key. Roughly, on a cheap model:

| What | Cost |
| --- | --- |
| a 4-tick smoke run | ~$0.15 |
| a full 32-tick day | ~$2 |
| cloning a business from one sentence | one generation pass, cents |
| cloning a shipped template | $0 — no model call at all |
| the tests, the typecheck, CI | $0 — no model call at all |

The day, the model and the judge all move it: the 12-tick run above cost $0.60.

`npm run sonata -- bench --dry-run` prices a whole matrix before running any of
it, and `--max-cost` and `--budget` stop a run and a matrix at a number you set. A run
that finished suspiciously fast at $0 did not happen — check the spend on the
report.

## Environment

Every variable the code reads is documented in
[`.env.example`](.env.example); only `OPENROUTER_API_KEY` has no working default,
and `npm run sonata -- init` is what writes it. Copy the example by hand instead
and the placeholder comes with it — `npm run sonata -- doctor` reports a
placeholder as no key, which is what it is.

**The name is `OPENROUTER_API_KEY`.** `OPEN_ROUTER_KEY` is silently ignored —
the run starts, the world seeds, and then every model call fails with
"OPENROUTER_API_KEY is not set" while everything else looks healthy. That one
has already cost an afternoon.

## Requirements

Node **>= 22**, and npm workspaces.

The floor is 22 because the OpenAI client (v7, which is how Sonata talks to
OpenRouter) requires it. The repo's own code would run on 20.12 — that is where
`process.loadEnvFile` arrived, which is how the CLIs read `.env` with no
dependency — but the dependency floor is the binding one. Developed on 25.

`better-sqlite3` is a native module; a clean install builds or downloads it.

## Layout

```
apps/gmail  apps/slack  apps/calendar   the clones (SQLite, local)
apps/gmail-ui                           the Gmail front end, over OAuth
apps/platform                           the dashboard, and the commands it shares
packages/cli        `npm run sonata` — doctor, init, up/down, and the front door to the rest
packages/core       shared types, the failure-mode catalog, scoring
packages/engine     the tick clock, scripted beats, the director, the agent loop
packages/judge      checkers, the deterministic checklist, the episode judge
packages/world      one sentence -> a coherent company across all three clones
packages/mcp        the stdio MCP server an outside agent connects through
packages/scenarios  the five hand-written days the benchmark runs on
packages/benchmark  scenarios x models x seeds, resumable, budgeted
packages/ui         the design system
```

[`AGENTS.md`](AGENTS.md) is the working guide — the invariants, and the things
that have actually gone wrong. Read it before changing anything.

## Tests

```bash
npm run typecheck --workspaces --if-present
npm run test --workspaces --if-present
```

No model calls, no network, no secrets: the suites run on a clean clone with no
`.env`. [CI](.github/workflows/ci.yml) runs these on every push and pull
request, plus `tsc --noEmit` over the few workspaces that ship no `typecheck`
script of their own.

None of that talks to a running server, and the defects that have actually cost
time here all passed the type checker. Two gates drive the real thing, against a
clone that is up:

```bash
npm run dev:gmail:api                  # in one shell

PORT=3101 npm run smoke -w apps/gmail  # the official SDK, incl. a real OAuth handshake
npm run check:twin                     # the harness, against a live clone
```

`smoke` is the clone's own gate: it drives the *official* `googleapis` SDK
through a full authorize → consent → token exchange, then 59 checks over reads,
writes, per-route scopes and consent denial.

`check:twin` is the other direction — the engine's `TwinAdapter` contract against
a running clone — and it asserts the property above rather than assuming it: the
admin token is refused by `/gmail/v1/*`, and the mint bridge is refused without
the admin token. Three separate code paths have now grown their own idea of how
to authenticate to Gmail; this is the check that notices the fourth.

## What this is not

- **Not a hosted service.** It is local-first and single-user. There is no
  account, no tenancy, no server to sign up for; `data/` on your disk is the
  whole state.
- **Not real Gmail, Slack or Calendar.** The clones are fake servers that
  reimplement enough of each API to be indistinguishable to an SDK, not proxies.
  Unimplemented corners answer in the vendor's own shape — see
  [apps/gmail](apps/gmail/README.md) and [apps/slack](apps/slack/README.md) for
  what is missing.
- **Not a way to touch your real accounts.** The optional sync CLIs pull with
  read-only scopes into a local snapshot and never write back. Everything the
  agent does happens to a copy.
- **Not free.** Cloning a business and running a day are model calls on your own
  key.
- **Not a leaderboard.** It scores your agent on days you chose, in a business
  you described. Two runs of the same day are comparable because a reset is a
  file copy; two different days are not.

## Licence

MIT — see [LICENSE](LICENSE).
