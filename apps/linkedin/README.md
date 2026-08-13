# LinkedIn clone

**Read this first.** LinkedIn's API is mostly partner-gated. This clone
implements only the publicly documented subset — the OpenID Connect profile
call, organization access control, Organization Lookup, the Posts API, and the
socialActions / socialMetadata / reactions surfaces — and it implements them as
a **local fake for agent benchmarking**. Messaging and conversations,
connections and invitations, profile and people search, follower and share
statistics, Lead Gen Forms and the Ads APIs are partner-only at LinkedIn; they
are **not implemented here and will not be**. An agent that finds this clone must
not conclude that a route to data LinkedIn does not expose exists somewhere.
Nothing in this repository scrapes LinkedIn or circumvents its access controls,
and this service makes no outbound request of any kind.

One of the clones that make up [Sonata Labs](../../README.md) — read the root
README for what the product is and how a scenario runs. This file is about the
LinkedIn surface only.

It serves a **LinkedIn-shaped REST API** over a mutable SQLite copy of one
company page. Every write hits the local database, is recorded in an audit log
the judge reads afterwards, and is undone by one reset.

| workspace | port | what |
|---|---|---|
| `apps/linkedin` | 3800 | the API: `/v2/*`, `/rest/*`, `/api/sandbox/*`, `/api/health`, `/api/activity` |
| `apps/linkedin-ui` | 4600 | reserved. No replica UI is built in this phase. |

- **[AGENTS.md](AGENTS.md)** — working in this app: commands, layout, conventions, how to add an endpoint.

## Run it

```bash
npm run db:init -w apps/linkedin   # first time, or after a schema change
npm run seed -w apps/linkedin      # the Acme page: 7 posts, 17 comments, 40 reactions
npm run dev:linkedin               # from the repo root: :3800
PORT=3800 npm run smoke -w apps/linkedin   # the acceptance gate, needs the server up
```

`data/*.db` is gitignored, so a fresh checkout has the schema and none of the
tables and every route answers `no such table`. `db:init` is safe to re-run —
every statement in `db/schema.sql` is `CREATE TABLE IF NOT EXISTS`.

## One credential, two surfaces

`SANDBOX_TOKEN` (default `sandbox-token`) gates both halves, so the orchestrator
carries one credential per twin.

- The **provider API** (`/v2/*`, `/rest/*`) takes it as `Authorization: Bearer`.
  A missing header is LinkedIn's `401 Empty oauth2_access_token`; a wrong one is
  `401 INVALID_ACCESS_TOKEN`.
- The **control plane** (`/api/sandbox/*`) takes the same token via
  `X-Sandbox-Token`, a bearer, or `?access_token=`, and answers in plain
  `{ok:false,error}` JSON — never the LinkedIn envelope. Those routes are
  machinery; dressing them as LinkedIn would teach an agent that stumbled onto
  them the wrong thing.

There is no OAuth2 authorization server here. That is deliberate: the Calendar
and Slack clones use a static token too, and the Gmail clone's `/oauth/*` model
only earns its complexity once an episode needs per-scope denial.

## Who may write what

There is one authenticated member — the page owner — and every write is decided
against them, because that is how LinkedIn scopes `w_member_social`:

- A person may only act as **themself**. Naming another member as `author` or
  `actor` is `403 ACCESS_DENIED`, never a 404: the caller can see that member,
  they just may not speak for them.
- A page may only be acted as through an **APPROVED ADMINISTRATOR** ACL, and the
  resulting comment records which admin did it (`agent`, and `impersonator`
  inside both audit stamps).
- **Editing and deleting a post are decided by the post's own author**, since a
  patch body names no actor at all. Another member's post is a 403 both times,
  including on the repeat DELETE that would otherwise be an idempotent 204. A
  patch that sets nothing is a `400 MISSING_FIELD`, not a 204: an edit that
  changed nothing would still be logged as an edit.
- A **DRAFT** is the author's own business — *its* author, not whoever asks.
  `viewContext=AUTHOR` reveals it to the member who wrote it (or to an
  administrator of the page that did) and a `lifecycleState` patch publishes it;
  until then socialMetadata, the comments finder, comment create and reactions
  all answer 404, the same as a post that never existed. Asking as `AUTHOR` about
  somebody else's drafts is not an error, it is simply the reader's view. That
  transition runs one way: patching a live post back to `DRAFT` is a 400, because
  it would take the post off every reader surface while logging the removal as an
  edit.

## The API surface

Every `/rest/` call needs `LinkedIn-Version: 202506` (six digits; anything below
202506 answers `426 VERSION_DEPRECATED`, matching LinkedIn's rolling one-year
sunset window). `X-Restli-Protocol-Version: 2.0.0` is accepted and optional; a
*different* value is a 400.

| this clone | real vendor equivalent |
|---|---|
| `GET /v2/userinfo` | `GET https://api.linkedin.com/v2/userinfo` |
| `GET /rest/organizationAcls?q=roleAssignee\|organization` | `GET /rest/organizationAcls` |
| `GET /rest/organizations/{id}` | `GET /rest/organizations/{id}` (Organization Lookup by id) |
| `GET /rest/posts?q=author&author={urn}` | Posts API author finder |
| `POST /rest/posts` | Posts API create — **201, empty body, `x-restli-id`** |
| `GET /rest/posts/{urn}` | Posts API get |
| `POST /rest/posts/{urn}` + `X-RestLi-Method: PARTIAL_UPDATE` | Posts API partial update — **204** |
| `DELETE /rest/posts/{urn}` | Posts API delete — **204, idempotent** |
| `GET /rest/socialMetadata/{urn}` | socialMetadata |
| `GET\|POST /rest/socialActions/{urn}/comments` | socialActions comments — a reply names its parent either as the `{urn}` segment or as `parentComment` in the body, and threads are one level deep on both spellings |
| `POST /rest/reactions?actor={urn}` | Reactions API create |

```bash
T='authorization: Bearer sandbox-token'
V='linkedin-version: 202506'
ORG='urn%3Ali%3Aorganization%3A7412903'

curl -s -H "$T" localhost:3800/v2/userinfo
curl -s -H "$T" -H "$V" 'localhost:3800/rest/organizationAcls?q=roleAssignee&state=APPROVED'
curl -s -H "$T" -H "$V" localhost:3800/rest/organizations/7412903
curl -s -H "$T" -H "$V" "localhost:3800/rest/posts?q=author&author=$ORG&count=5&sortBy=LAST_MODIFIED"

# create: read the id off the response HEADER, not the body — there is no body
curl -s -D- -o/dev/null -X POST -H "$T" -H "$V" -H 'content-type: application/json' \
  -d '{"author":"urn:li:organization:7412903","commentary":"Hello","visibility":"PUBLIC",
       "distribution":{"feedDistribution":"MAIN_FEED","targetEntities":[],"thirdPartyDistributionChannels":[]},
       "lifecycleState":"PUBLISHED","isReshareDisabledByAuthor":false}' \
  localhost:3800/rest/posts

P='urn%3Ali%3Ashare%3A7487797749352832044'
curl -s -H "$T" -H "$V" "localhost:3800/rest/posts/$P"
curl -s -H "$T" -H "$V" "localhost:3800/rest/socialMetadata/$P"
curl -s -H "$T" -H "$V" "localhost:3800/rest/socialActions/$P/comments"

# edit, publish a draft, delete — all through the same entity URL
curl -s -X POST -H "$T" -H "$V" -H 'x-restli-method: PARTIAL_UPDATE' \
  -H 'content-type: application/json' \
  -d '{"patch":{"$set":{"commentary":"Hello, edited"}}}' "localhost:3800/rest/posts/$P"
curl -s -X DELETE -H "$T" -H "$V" "localhost:3800/rest/posts/$P"

# react as yourself; `actor` is a QUERY parameter here, not a body field
ME='urn%3Ali%3Aperson%3AsHq2WpRk9L'
curl -s -X POST -H "$T" -H "$V" -H 'content-type: application/json' \
  -d '{"root":"urn:li:activity:7487797749352832044","reactionType":"LIKE"}' \
  "localhost:3800/rest/reactions?actor=$ME"

curl -s localhost:3800/api/health
curl -s localhost:3800/api/activity
```

## What the seed contains

Acme — the same business the Gmail, Slack and Calendar clones seed, with the same
four cast members (`sandbox.user@gmail.com`, `priya@acme.co`, `dan@acme.co`,
`mei@acme.co`) and the same anchor week (Monday 2026-07-27), plus eight members of
the public who follow the page. Sandbox User is an APPROVED ADMINISTRATOR of
`urn:li:organization:7412903`; Priya is too; Dan has REQUESTED and not been
granted, so `state=APPROVED` is a filter that actually removes a row.

Seven posts: five on the page, two by Sandbox User personally, one of them a
DRAFT nobody published. Engagement is uneven on purpose — the outage post-mortem
carries nine comments (two of them replies, one from an outsider whose question
nobody answered) and eleven reactions, the release note has none at all. So
"check the engagement on a post" has a right answer and a wrong one, and "answer
the comments" has an obvious first target.

## Three databases

| file | what | survives a reset |
|---|---|---|
| `data/snapshot.db` | the pristine world every run starts from | yes |
| `data/working.db` | what the API reads and writes | no — it is replaced by the snapshot |
| `data/audit.db` | sessions + the action log the judge reads | yes |

A reset is `copyFileSync(snapshot.db, working.db)`. It runs in the server process
because the server owns the SQLite handle.

## Not implemented, and not coming

These return LinkedIn-shaped 404s if reached, never a plausible fake:

- **Everything partner-gated**: messaging and conversations; connections,
  invitations and the member network; profile and people search; any profile
  lookup for a member other than the authenticated one; follower statistics,
  `organizationalEntityShareStatistics` and the analytics endpoints; the finder
  halves of Organization Lookup; Lead Gen Forms; the Ads / Campaign Management
  API.
- **Any form of scraping, cookie replay, or circumvention of LinkedIn's access
  controls.** The clone makes no outbound request of any kind.
- Non-text post content — Images, Videos, Documents, Polls, MultiImage, Carousel
  and Celebration posts, and the asset-upload APIs behind them. `content` is
  accepted into `raw_json` and echoed back verbatim, never interpreted.
- Sponsored content: `adContext`, dark posts, the `dscAdAccount` finder.
- Targeted organic posts. `distribution.targetEntities` is accepted on create and
  never enforced; there is no audienceCounts endpoint and no 300-member floor.
- The `little` text format. Mentions and hashtag templates round-trip verbatim;
  the clone neither parses nor renders them.
- Rest.li BATCH_GET (`?ids=List(...)`), query tunnelling
  (`X-HTTP-Method-Override`), and batch create/update/delete. One entity at a
  time.
- Reaction listing (`GET /rest/reactions?q=entity`) and reaction deletion.
  Engagement is answered by socialMetadata's counts; enumerating individual
  reactors is the privacy-sensitive, partner-gated half.
- Comment editing and deletion, and toggling `commentsState` through
  `POST /rest/socialMetadata/{urn}`. The column exists and is honoured on read —
  a post whose comments are CLOSED refuses a new one — but only the seed writes
  it.

## Registration is phase 2

This clone is deliberately absent from `TwinName`, `TWIN_API_PORTS`, the platform
dashboard and the CLI's app list, so `sonata up` and `sonata doctor` do not see
it. Adding the name to that union breaks roughly twenty exhaustive
`Record<TwinName, X>` maps at typecheck, which is the point: registration is a
decision, not a side effect.
