# Google Ads twin

One of the clones that make up [Sonata Labs](../../README.md) — read the root
README for what the product is and how a scenario runs. This file is about the
Google Ads surface only.

It serves a **Google Ads-shaped REST API** over a mutable copy of one advertiser
account in SQLite, with a **real GAQL parser** behind the reporting endpoints.
Every mutation hits the local DB, is recorded in an audit log the judge reads
afterwards, and is undone by one reset. The runtime has no Google credentials and
cannot reach Google.

| workspace | port | what |
|---|---|---|
| `apps/google-ads` | 3700 | the API: `/v*/customers/*`, `/api/sandbox/*`. No UI of its own — port 4500 is reserved for a Phase-2 UI and no app is built against it. |

- **[AGENTS.md](AGENTS.md)** — working in this app: commands, layout,
  conventions, what is deliberately out of scope.

## What it is not

It is not a full Google Ads API. The GAQL grammar is deliberately restricted and
every omission is refused **by name** with a real error code, because an honest
"this sandbox does not support `REGEXP_MATCH`" is worth far more to an agent than
a permissive parser that quietly misreads the condition. Four resources are
queryable (`customer`, `campaign`, `campaign_budget`, `ad_group`) plus `metrics`
and `segments.date`; two resources are mutable (`campaigns`, `campaignBudgets`).
`campaigns:mutate` `create` answers a 501 that names the alternative.

It is also not yet an episode twin: there is no engine adapter, judge checker or
dashboard card. Those are Phase 2 and none of them live here.

## Run it

```bash
npm run db:init -w apps/google-ads        # first time, or after a schema change
npm run seed -w apps/google-ads           # 5 campaigns, 9 ad groups, 30 days of stats
PORT=3700 npm run dev -w apps/google-ads
```

A world normally arrives from the platform, which POSTs a whole company to
`/api/sandbox/seed`. The synthetic seed above exists so the twin runs standalone.

Its clock is fixed at **Monday 2026-08-03 09:00 America/New_York**, so
`DURING LAST_7_DAYS` always resolves to 2026-07-27 … 2026-08-02 — the same week
the Calendar twin seeds. That is why last week's report is the same number on
every run.

## Two credentials, and both are required

Every `/v*/…` call needs an `Authorization: Bearer` token **and** a non-empty
`developer-token` header. The developer token's value is not checked — the
sandbox is not an approval gate — but its absence is, because that requirement is
what makes Google Ads' auth different from every other Google API.

The calls below are the ones in Google's own REST examples, unchanged apart from
the host.

```bash
# Which account am I allowed to touch?
curl -s localhost:3700/v17/customers:listAccessibleCustomers \
  -H 'authorization: Bearer sandbox-token' \
  -H 'developer-token: sandbox-dev-token'
# {"resourceNames":["customers/4802938157"]}

# Last week's spend by campaign, worst first.
curl -s -X POST localhost:3700/v17/customers/4802938157/googleAds:search \
  -H 'authorization: Bearer sandbox-token' \
  -H 'developer-token: sandbox-dev-token' \
  -H 'content-type: application/json' \
  -d '{"query":"SELECT campaign.name, campaign_budget.amount_micros, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS ORDER BY metrics.cost_micros DESC"}'

# Pause the campaign that overspent. The updateMask is not decoration:
# a field in the body but not in the mask is ignored.
curl -s -X POST localhost:3700/v17/customers/4802938157/campaigns:mutate \
  -H 'authorization: Bearer sandbox-token' \
  -H 'developer-token: sandbox-dev-token' \
  -H 'content-type: application/json' \
  -d '{"operations":[{"update":{"resourceName":"customers/4802938157/campaigns/17204885331","status":"PAUSED"},"updateMask":"status"}]}'

# Or raise its budget instead. Money is micros: $400.00 is 400000000.
curl -s -X POST localhost:3700/v17/customers/4802938157/campaignBudgets:mutate \
  -H 'authorization: Bearer sandbox-token' \
  -H 'developer-token: sandbox-dev-token' \
  -H 'content-type: application/json' \
  -d '{"operations":[{"update":{"resourceName":"customers/4802938157/campaignBudgets/11938204472","amountMicros":400000000},"updateMask":"amountMicros"}]}'
```

Any `/v<digits>/` prefix is served, and the version you send is the one named in
the `@type` of any error — googleads.googleapis.com serves many versions at once,
and pinning one would 404 an agent whose docs name a different one.

## The three databases

| file | what |
|---|---|
| `data/snapshot.db` | the pristine account. `reset` copies this over `working.db`. |
| `data/working.db` | what the API reads and writes. |
| `data/audit.db` | `sessions` + `action_log`, ATTACHed onto the working handle so a mutation and its audit row commit together — and a separate file, so the trail survives a reset. |

All three are gitignored. `npm run db:init` recreates them from
`db/schema.sql`, which every one of them is applied to verbatim.

## Why there is no SDK smoke test

The other clones' acceptance harnesses drive the official vendor SDK with only
the base URL overridden. Google ships no official Node client for the Ads API
(Java, .NET, PHP, Python, Ruby and Perl only), so there is no SDK to point at
this twin. The documented REST transport **is** the interface, and
`scripts/smoke-sdk.ts` issues those calls with plain `fetch`. If it passes, an
agent working from developers.google.com/google-ads/api/rest works against the
sandbox unchanged.

```bash
PORT=3700 npm run smoke -w apps/google-ads
```

It resets to the snapshot as its first act so it is repeatable — which means it
also destroys whatever world is loaded. Never point it at a twin mid-episode.
