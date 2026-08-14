# Google Docs Sandbox Clone

A Google Docs API v1 clone for agent testing. The design property that matters:
**the official `googleapis` SDK talks to it with only `rootUrl` overridden** — no
shim, no wrapper, no mock transport. If an agent works against this, it works
against Google.

```js
import { google } from "googleapis";

const auth = new google.auth.OAuth2();
auth.setCredentials({ access_token: "sandbox-token" });

const docs = google.docs({ version: "v1", auth, rootUrl: "http://localhost:3600" });
const doc = await docs.documents.get({ documentId });
```

Documents are stored as paragraphs and text runs, not as a markdown blob. Every
`StructuralElement` and every `ParagraphElement` carries `startIndex`/`endIndex` in
one flat, document-wide space measured in UTF-16 code units, and `batchUpdate`
operates on those numbers — so an agent that reads a heading's `endIndex` and
inserts there lands where it expects to. An emoji costs two of those indexes, and
the one between its halves behaves the way Google's does: a delete that would
split it is a 400 and an insert is nudged past it. Text that arrives already
carrying half a pair is refused for the same reason — stored, it would come back
as U+FFFD, a character destroyed with a 200 to say it went well.

## Ports

| Service | Port | Status |
| --- | --- | --- |
| API | 3600 | this app |
| UI | 4400 | reserved, not built (phase 2) |

## Run it

```bash
npm install                            # from the repo root
npm run db:init -w apps/google-docs    # create the three databases
npm run seed -w apps/google-docs       # load the synthetic Acme workspace
PORT=3600 npm run dev -w apps/google-docs
PORT=3600 npm run smoke -w apps/google-docs   # the acceptance gate, needs the server
```

`data/*.db` is gitignored, so `db:init` is the first thing to run on a fresh
checkout — without it every route answers `no such table`.

The smoke is a writer, not an observer: it resets to the pristine snapshot first
(so it repeats cleanly, and so it wipes whatever world is loaded — never run it
against a twin mid-episode), then creates a document and edits a seeded one. Run
`npm run seed -w apps/google-docs` afterwards to get the pristine workspace back.

## The three databases

| File | What it is |
| --- | --- |
| `data/snapshot.db` | The pristine world. A reset copies this over working.db. |
| `data/working.db` | What the API reads and writes. Disposable. |
| `data/audit.db` | Sessions and the action log. Survives every reset, because the trail is the evidence. |

## Credentials

One static token, `SANDBOX_TOKEN` (default `sandbox-token`), gates both surfaces.
The Docs API takes it as an OAuth-style bearer; the control plane also accepts
`X-Sandbox-Token`.

```bash
# documents.get
curl -s -H "Authorization: Bearer sandbox-token" \
  "http://localhost:3600/v1/documents/1QbrAcme3xR7pLmN9vKdT2wYzHf4JsU6eXo0BnCgVaMi"

# documents.batchUpdate — note the literal `:batchUpdate` custom method
curl -s -X POST -H "Authorization: Bearer sandbox-token" -H "content-type: application/json" \
  -d '{"requests":[{"replaceAllText":{"containsText":{"text":"[[HEADCOUNT]]"},"replaceText":"6"}}]}' \
  "http://localhost:3600/v1/documents/1QbrAcme3xR7pLmN9vKdT2wYzHf4JsU6eXo0BnCgVaMi:batchUpdate"

# the control plane
curl -s -H "X-Sandbox-Token: sandbox-token" http://localhost:3600/api/sandbox/snapshot

# liveness, no credential
curl -s http://localhost:3600/api/health
```

The Docs API has no list method, and neither does this clone. Open
`http://localhost:3600/` to see the seeded document ids, or read them out of
`/api/sandbox/snapshot` — in a real episode an agent finds them through a link in
the Gmail or Slack twin, which is the intended flow.

## What it is not

Not a Drive clone: no listing, searching, folders, permissions, sharing, comments
or revision history. Not a full Docs clone either — tables answer an honest 501,
and images, headers, footers, footnotes, lists and suggestions are out of scope
rather than half-modelled, because a half-modelled table puts every subsequent
index out of step with the real API. See `AGENTS.md` for the complete list and for
the invariants any change has to preserve.
