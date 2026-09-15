# Desk twin

The line-of-business system a continuity week runs on: the records, receipts and
submissions a critical-infrastructure desk works in, plus the append-only event
log the week is assessed from.

It is a twin like Gmail or Excel, which is what gives a run its own isolated
copy, one audit log, one snapshot pair and one set of MCP tools. It differs from
the others in two ways.

**Its verbs come from the week, not from a vendor.** `SONATA_DESK_CASE` names the
case this process serves (`W01` water incident reporting, `E01` electricity
outage support). The tools are read from that domain in `@sonata/desks`, so an
E01 run never sees W01's verbs. A process without the variable serves no tools
rather than guessing.

**It owns simulated time.** Every rule in a continuity domain is written against
an instant — whether a source has been superseded, whether a review window is
open, whether a submission is late. A tool call carrying its own `at` would let a
model choose which deadlines it had met, so the instant lives here and only the
control credential moves it, through `POST /api/sandbox/advance`.

## Routes

Agent credential (`SANDBOX_TOKEN`):

| Route | |
| --- | --- |
| `GET /api/tools` | The verbs this week offers, with their schemas. |
| `POST /api/tools/<name>` | `{args}`. No instant is read off the request. |

Control credential (`SANDBOX_CONTROL_TOKEN`):

| Route | |
| --- | --- |
| `POST /api/sandbox/seed` | Lay down the case's opening records. |
| `POST /api/sandbox/reset` | Rebuild the ledger from scratch. |
| `POST /api/sandbox/advance` | `{at, phase}` — move the clock and fire the week's schedule. |
| `GET /api/sandbox/snapshot` | Every record and every event, with its actor. |
| `GET /api/activity?sinceId=` | The agent's own operations only. |
| `POST /api/sandbox/assess` | `{completedThrough}` — the deterministic assessment. |

`GET /api/health` needs no credential.

The agent's audit log carries only the agent's operations. The world's scheduled
consequences are in the snapshot, where the assessment reads them, because a desk
that slept through a week should not look busy for having had receipts arrive.

## Running it

```bash
SONATA_DESK_CASE=E01 npm run dev:desk     # port 3960
```

## What this does not establish

The weeks are authored specifications. No practitioner has reviewed E01's outage
support rules or W01's incident reporting rules, and neither is validated as a
description of how these desks actually work.
