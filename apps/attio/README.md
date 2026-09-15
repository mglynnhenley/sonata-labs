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
| `apps/attio` | 3500 | browser replica at `/`; API at `/v2/*`, `/api/health`, `/api/activity`, `/api/sandbox/*` |

- **[AGENTS.md](AGENTS.md)** — working in this app: commands, layout, conventions, how to add an endpoint.

## What it is not

The twin is registered with the platform, engine and CLI. Open the Attio card
in Sonata, or visit http://localhost:3500. The embedded browser has companies,
people, a deal table and pipeline, linked records, notes and tasks. Search and
stage filters narrow the view; record forms and task checkboxes write to the
same local CRM as the agent API. Refresh reloads the current state.

The browser bridge at `/api/ui/*` delegates to the existing API handlers, keeps
the sandbox credential on the server and rejects cross-origin browser requests.
It does not expose sandbox reset or seed operations. All paginated CRM records,
notes and tasks are loaded; the browser does not stop at the first API page.

It is not a whole CRM either. Eleven endpoints are mounted; everything else on
Attio's surface — objects and attributes CRUD, lists and list entries, comments,
threads, webhooks, the value-history endpoint — answers a 404 in Attio's own
error envelope naming what *is* mounted, rather than being faked. A verb Attio
declares on a path this clone *does* mount answers 501 in that same envelope:
record upsert, `PUT` and `DELETE` on a record, and task get/delete.

One gap is left deliberately ragged: a verb Attio declares on *no* path — `GET`
or `PATCH` on `/v2/objects/{object}/records`, say — gets Next's bodyless 405
rather than an Attio-shaped error. Answering it in the envelope would mean
saying "not implemented in the sandbox" about an endpoint the real API does not
have either, and an agent would read that as a promise. An empty 405 teaches it
nothing, which here is the honest answer.

## Run it

```bash
npm run db:init -w apps/attio     # first time, or after a schema change
npm run seed -w apps/attio        # 9 records, 3 notes, 2 tasks — no Attio account
PORT=3500 npm run dev -w apps/attio
PORT=3500 npm run smoke -w apps/attio   # the acceptance gate; needs the server up
```

The smoke needs a port and a running server, so CI never runs it — that gate
only fires when a human does. It also resets to the snapshot and then writes a
company, a note, a task and a stage move, so `working.db` is left holding its
leavings: run `npm run seed -w apps/attio` again for a clean world.

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

`/api/health` stays public. `/api/activity` and `/api/sandbox/*` require the
harness control token: `SANDBOX_CONTROL_TOKEN`, falling back to `SANDBOX_TOKEN`
(and then `sandbox-token`) for development. Send it as `X-Sandbox-Token` or a
bearer. Provider APIs retain their `SANDBOX_TOKEN` credential.

## The three databases

| file | what |
|---|---|
| `data/snapshot.db` | the pristine world. `reset` copies this over `working.db`. |
| `data/working.db` | what the API reads and writes. |
| `data/audit.db` | sessions + action log. ATTACHed onto the working connection so a mutation and its audit row commit together, but a separate file so the trail survives a reset. |

All three are gitignored and all three are built from the one `db/schema.sql`.
