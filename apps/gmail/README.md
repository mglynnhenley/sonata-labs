# Gmail Sandbox Clone

A local, zero-risk Gmail clone for observing how an AI agent behaves against a
real-looking mailbox. It pulls your real Gmail **read-only** into a local SQLite
snapshot, then serves a **Gmail-compatible REST API** the official `googleapis`
SDK can drive by just overriding `rootUrl`. Every mutation (send/label/archive/
trash/delete) hits only the local DB, is recorded in an audit log, and can be
undone with one reset. Nothing is ever written back to Google.

## Docs

- **[AGENTS.md](AGENTS.md)** — working in this repo: commands, layout, conventions, how to add an endpoint.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how it fits together: the three DBs, request lifecycle, shaping, audit atomicity, send pipeline.

## What's here

- **Gmail-compatible API** at `/gmail/v1/users/{me|email}/…` — profile, messages
  (list/get/send/modify/trash/untrash/delete/batch/attachments), threads, labels
  CRUD, drafts CRUD + send. Static bearer auth. Faithful semantics (list returns
  `{id, threadId}` only, `nextPageToken` omitted on last page, TRASH/SPAM excluded
  by default, live label counts, base64url everywhere).
- **Gmail-replica UI** at `/` — top bar, left rail, message list, thread view, and
  a live **Agent Activity** panel (action feed + outbox + reset button).
- **Simulated writes** — "sent" mail lands in SENT + a fake outbox; nothing leaves
  the machine. Every write is logged to `audit.db`, which survives resets.
- **Read-only sync CLI** — pulls your real Gmail (`gmail.readonly` scope only).

## Quick start (synthetic data — no Google account needed)

```bash
npm install
npm run db:init      # create the three SQLite DBs
npm run seed         # populate a synthetic ~18-message mailbox
PORT=3100 npm start  # (port 3000 is often taken; any port works)
```

Open http://localhost:3100. Then drive it with the official SDK:

```bash
PORT=3100 npm run smoke   # 48 checks: reads + writes + reset, via googleapis
PORT=3100 npm run demo    # a mini "agent": list unread → read → label → archive → reply
```

Watch the Activity panel update live as the demo runs.

## Point it at your real Gmail (read-only)

1. In Google Cloud Console: enable the Gmail API, create an OAuth **Desktop app**
   client, and download its JSON to `data/credentials.json`
   (or set `GOOGLE_CREDENTIALS_PATH`).
2. Run the sync (consent screen shows **read-only** Gmail access only):

   ```bash
   npm run sync -- --query "newer_than:90d" --max 1000
   ```

   Options: `--attachment-cap 2` (MB per attachment), `--attachment-budget 100`
   (MB total), `--concurrency 5`. Idempotent — re-run any time.
3. Restart the server (or `npm run reset`) and open the UI with your real mail.

## Using the sandbox from an agent

Point the official SDK at the sandbox — only `rootUrl` and the token change:

```ts
import { google } from "googleapis";
const auth = new google.auth.OAuth2();
auth.setCredentials({ access_token: "sandbox-token" }); // SANDBOX_TOKEN env
const gmail = google.gmail({ version: "v1", auth, rootUrl: "http://localhost:3100" });
await gmail.users.messages.list({ userId: "me", labelIds: ["INBOX"] });
```

> Pass an `OAuth2Client` (not a string) so the token becomes an
> `Authorization: Bearer` header rather than a `?key=` query param.

## Triage stress-test eval

Measures whether a triage agent handles *genuinely hard* situations — not whether it
can be tricked. The classic case: an angry email from someone who already sent one.
Correct triage requires context the single message doesn't carry, so a naive agent
treats the escalation like a first complaint.

It's **data-agnostic**: it reads whatever mailbox is loaded, derives the owner's
persona and real contacts, then generates a trap email *in that mailbox's voice* from
a plausible real sender — where possible as a reply on a real thread.

```bash
export OPENROUTER_API_KEY=…                  # https://openrouter.ai/keys
PORT=3100 npm run eval -- --scenario escalation
PORT=3100 npm run eval -- --all              # all six scenarios
PORT=3100 npm run eval -- --list             # what's available
PORT=3100 npm run eval -- --scenario escalation --agent naive   # known-bad control
PORT=3100 npm run eval:check                 # verify the pipeline, no API key needed
```

**Models come from [OpenRouter](https://openrouter.ai)**, so you can grade any
tool-calling model by changing a slug — no code change. Slugs use dots, not dashes:

```bash
PORT=3100 npm run eval -- --scenario bump --model openai/gpt-5.4
OPENROUTER_MODEL=anthropic/claude-sonnet-4.6 PORT=3100 npm run eval -- --all
curl -s https://openrouter.ai/api/v1/models | jq -r '.data[].id'   # list slugs
```

Default is `anthropic/claude-opus-4.8`. `--model` sets the agent-under-test;
`OPENROUTER_MODEL` sets the default for every role (profiler, generator, judge, agent),
and `runEval({ models: {...} })` overrides each role individually — handy for grading a
cheap agent with an expensive judge.

Six scenarios across two difficulty families:

| id | The hard part |
|---|---|
| `escalation` | 2nd angry email, 1st unanswered |
| `bump` | "per my last email" — the original request is still open |
| `stale-urgency` | screams URGENT about a deadline already passed |
| `already-resolved` | a request withdrawn later in the same thread |
| `passive-aggressive` | polite surface, complaint underneath |
| `sensitive-personal` | private personal mail amid work triage |

**Grading is hybrid.** Deterministic assertions over the audit log and final mailbox
state carry it ("did it archive the escalation?" is a fact, not a judgment); an LLM
judge covers only the qualitative residue (was the reply tone appropriate?). `must`
violations fail the run; `should` violations cost score.

**The rubric is checked against a known-bad control.** `--agent naive` archives
everything and never reads history, so it *must* fail `escalation` and `bump`. If it
passes, the rubric is broken rather than the agent being good. `npm run eval:check`
verifies exactly that, plus injection/threading/observation, with no model calls.

Bring your own agent by implementing `TriageAgent` (`src/lib/eval/types.ts`) — anything
that drives the same `gmail` client is gradeable, because every mutation is audit-logged.
Runs are isolated: each resets to the pristine snapshot afterwards, and `audit.db`
survives. Reports land in `data/eval-runs/` (gitignored).

## Reset

```bash
npm run reset            # restore working.db from the pristine snapshot
```

Or click **Reset** in the Activity panel, or `POST /api/sandbox/reset`. The audit
trail in `audit.db` survives (a new session starts).

## Databases (`data/`, gitignored)

- `snapshot.db` — pristine synced/seeded copy (written only by sync/seed).
- `working.db` — what the sandbox serves and mutates. Reset copies snapshot → working.
- `audit.db` — sessions + action log. Separate file so it survives resets;
  ATTACHed to the working connection so each mutation + history bump + audit row
  commits in one transaction.

## Tests

```bash
npm test     # vitest: schema, search (~30 cases), FTS
npm run smoke # official-SDK acceptance harness (reads + writes + reset)
```

## Not implemented (Gmail-shaped 501/404)

`history.list` (501; historyId numbers are still maintained), `watch`/`stop`,
`settings.*`, `messages.insert/import`, multipart `/batch`, `/upload` media
variant. Incremental (historyId-based) sync is deferred — re-run `sync` instead.
