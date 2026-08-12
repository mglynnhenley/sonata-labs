# Attio twin

A clone in the [Sonata Labs](../../README.md) monorepo — read the root README for
what the product is and how a scenario runs. This file is about the Attio surface
only.

It serves an **Attio-compatible REST API** over a mutable copy of a CRM workspace
in SQLite, behind a single static Bearer key. Every mutation hits the local DB, is
recorded in an audit log the judge reads afterwards, and is undone by one reset.
The runtime has no Attio credentials and cannot reach Attio.

What makes it Attio rather than a generic CRM is the **versioned attribute value
model**: every value is a row carrying `active_from` and `active_until`, and a
write never updates one in place. Moving a deal's stage closes the old row and
opens a new one at the same instant, so "what stage was this deal on last
Tuesday" is a question the data can actually answer.

| workspace | port | what |
|---|---|---|
| `apps/attio` | 3500 | the API: `/v2/*`, `/api/health`, `/api/activity`, `/api/sandbox/*` |
| — | 4300 | reserved for an Attio-replica UI. Not built. |

- **[AGENTS.md](AGENTS.md)** — working in this app: commands, layout, conventions, how to add an endpoint.

## What it is not

It is **not registered as an episode twin** in this phase. `TwinName` is still
three names wide, so there is no engine adapter, no judge route, no dashboard
card, and `sonata up` / `sonata doctor` do not see this clone. Start it by hand.

It is not a whole CRM either. Eleven endpoints are mounted; everything else on
Attio's surface — objects and attributes CRUD, lists and list entries, comments,
threads, webhooks, the value-history endpoint — answers a 404 in Attio's own
error envelope naming what *is* mounted, rather than being faked. A verb Attio
declares on a path this clone *does* mount answers 501 in that same envelope:
record upsert, `PUT` and `DELETE` on a record, and task get/delete.

## Run it

```bash
npm run db:init -w apps/attio     # first time, or after a schema change
npm run seed -w apps/attio        # 9 records, 3 notes, 2 tasks — no Attio account
PORT=3500 npm run dev -w apps/attio
PORT=3500 npm run smoke -w apps/attio   # the acceptance gate; needs the server up
```

A world normally arrives from the platform, which POSTs a whole company to
`/api/sandbox/seed`. The demo seed above is what makes the clone runnable
standalone: the workspace is **Acme**, the operator is Sandbox User
<sandbox.user@gmail.com>, and one of the three accounts is deliberately
**Northwind** — the same client whose escalation call sits on the Calendar twin's
seed, so a cloned business reads coherently across surfaces.

## One credential

`SANDBOX_TOKEN` (default `sandbox-token`) gates both surfaces. Attio authenticates
with a Bearer API key and nothing else, so unlike the Gmail twin there is no OAuth
mode and no token endpoint — the API key and the control-plane token are the same
string, and only the shape of the failure differs.

```bash
curl -s localhost:3500/api/health
curl -s -H "Authorization: Bearer sandbox-token" localhost:3500/v2/self

# the versioned value, in the response:
curl -s -X POST localhost:3500/v2/objects/deals/records/query \
  -H "Authorization: Bearer sandbox-token" -H "content-type: application/json" \
  -d '{"filter":{"stage":"In Progress"}}'
```

That last call returns the Northwind renewal with

```json
"stage": [{
  "active_from": "2026-07-23T13:00:00.000000000Z",
  "active_until": null,
  "attribute_type": "status",
  "status": { "title": "In Progress", "celebration_enabled": false, ... }
}]
```

— and the `Lead` row it superseded four days earlier is still in the database,
closed rather than deleted.

`/api/health` takes no credential. `/api/activity` is read-only and ungated on
purpose: it is the evidence, not a lever.

## The three databases

| file | what |
|---|---|
| `data/snapshot.db` | the pristine world. `reset` copies this over `working.db`. |
| `data/working.db` | what the API reads and writes. |
| `data/audit.db` | sessions + action log. ATTACHed onto the working connection so a mutation and its audit row commit together, but a separate file so the trail survives a reset. |

All three are gitignored and all three are built from the one `db/schema.sql`.
