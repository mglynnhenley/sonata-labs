# apps/linkedin — working notes

Read [../../AGENTS.md](../../AGENTS.md) first; it covers the things that have
gone wrong across the whole repo. This file is about the LinkedIn clone.

## What this is

One of Sonata's clones: a LinkedIn-shaped REST API served over a mutable SQLite
copy of one company page. Writes are simulated, audit-logged, and graded from
that log. Nothing reaches LinkedIn, and nothing here is a route to data LinkedIn
does not expose — README.md opens with that paragraph and it is the first thing
to keep true.

## This clone is not an episode twin yet

It is deliberately absent from `TwinName` (packages/core/src/types/world.ts),
`TWIN_API_PORTS`/`TWIN_UI_PORTS`, `apps/platform/src/lib/twins.ts` and the
hardcoded clone list in `packages/cli/src/apps.ts`, so `sonata up` and `sonata
doctor` do not see it. That registration is phase 2, and adding a fourth name to
the union breaks roughly twenty exhaustive `Record<TwinName, X>` maps at
typecheck — which is the point. Also phase 2: the engine adapter, the judge's
checklist entries, MCP tools, and any dashboard wiring.

The port lives in exactly one place that matters: the root `package.json`'s
`dev:linkedin` script (`PORT=${PORT:-3800}`). `packages/core/src/ports.ts` is
`Record<TwinName, number>` and cannot take it until the union does.

## Two credentials, one token

`SANDBOX_TOKEN` (default `sandbox-token`) gates both surfaces:

- the provider API (`/v2/*`, `/rest/*`) as `Authorization: Bearer`, failing with
  the LinkedIn envelope — `src/lib/linkedin/auth.ts`;
- the control plane (`/api/sandbox/*`) as `X-Sandbox-Token`, a bearer or
  `?access_token=`, failing with `{ok:false,error}` and a real HTTP status —
  `src/lib/sandbox/auth.ts`.

There is no OAuth2 server. If a phase-2 episode wants to grade scope-denial
behaviour, that is when Gmail's `/oauth/*` + `POST /api/sandbox/token` model
earns its keep — and note that `packages/engine/src/http.ts` keys re-minting off
an `OAUTH_TWINS` list, so adding this clone to that list before the endpoints
exist would fail in a confusing place.

## Commands

```bash
npm run db:init -w apps/linkedin              # apply db/schema.sql to all three DBs
npm run seed -w apps/linkedin                 # the Acme page
PORT=3800 npm run dev -w apps/linkedin        # or `npm run dev:linkedin` from the root
npm run typecheck -w apps/linkedin
npm run test -w apps/linkedin
PORT=3800 npm run smoke -w apps/linkedin      # needs a running server and a seeded page
npm run reset -w apps/linkedin
```

`PORT` is load-bearing everywhere and a wrong one does not fail loudly: `reset`
will happily reset a different server on the port you gave it and report success.

## Definition of done for API changes

`npx tsc --noEmit` clean, `npm test` green, `PORT=3800 npm run smoke` all-pass
(86 checks today). The smoke needs a running server and a seeded world, is not
part of `npm test`, and CI never runs it — so the acceptance gate only runs when
a human runs it. It also resets to the snapshot as its first act, which destroys
whatever world is loaded; never point it at a twin mid-episode.

**There is no HTTP-level test harness here**, and that is the gap to know about:
`tests/` aliases `@` to `src` and `getDb()` would open the real `data/` files, so
a route can only be unit-tested through the library it calls. Everything that
lives in the wiring rather than in a function is therefore proven by the smoke
alone — the 403s on another member's post, the one-level thread refusal, the
`viewContext=AUTHOR` author check, every status code, and every response header.
Change a route and the unit suite can stay green while the surface breaks; run
the smoke.

Its last block seeds a two-author world over `/api/sandbox/seed` and resets
afterwards, because the demo seed cannot express the case it tests: every post in
it belongs to the owner or to the page they administer.

## Environment quirks

- Node 25 compiles better-sqlite3 from source on install.
- `data/*.db` is gitignored, so a fresh checkout answers `no such table` until
  `npm run db:init` has run.
- Never run `next build` while a dev server is up — they fight over `.next`.
- Use `127.0.0.1`, not `localhost`, in anything that fetches this server. Node
  resolves `localhost` to `::1` first and the Next dev server listens on IPv4
  only; the resulting ECONNREFUSED reads as "the twin is down" when it is fine.
  Both `src/cli/reset.ts` and `scripts/smoke-sdk.ts` learned this the hard way.
- In a detached shell, `next dev` needs stdin held open or it prints Ready,
  serves one request and exits. `tail -f /dev/null | PORT=3800 npm run dev -w
  apps/linkedin` is the incantation; the symptom otherwise is a smoke that passes
  its first few checks and then cannot connect.
- Kill this server BY PORT (`lsof -nP -iTCP:3800 -sTCP:LISTEN`), never by name.
  A `pkill -f 'next dev'` takes out every sibling clone's dev server too, and
  they are all `next dev`.

## Layout

```
app/v2/userinfo                          who the agent is
app/rest/organizationAcls                which page it may act as
app/rest/organizations/[organizationId]  which company that URN names
app/rest/posts, app/rest/posts/[postUrn] the headline read and the headline writes
app/rest/socialActions/[entityUrn]/comments
app/rest/socialMetadata/[entityUrn]      "check the engagement on a post"
app/rest/reactions
app/api/health, app/api/activity         ungated: liveness, and the evidence
app/api/sandbox/{seed,inject,snapshot,reset}   token-gated machinery
src/lib/linkedin/                        urn, ids, errors, auth, actor, paging,
                                         shape, post-input, route-helpers
src/lib/store/                           one file per table family, raw SQL, db first
src/lib/sandbox/                         auth, types, parse, seed, inject, live
src/lib/{db,audit,reset,seed}.ts
```

## Conventions specific to this clone

- **URNs go through `src/lib/linkedin/urn.ts` and nowhere else.** Do not build one
  with a template literal in a route. `parseUrn` never throws — a malformed URN
  is `null` so the caller can raise the documented 400 instead of a 500.
- **Post and comment ids are strings.** A 19-digit snowflake overflows
  `Number.MAX_SAFE_INTEGER`, and one `JSON.parse` into a number corrupts it
  silently.
- **`X-RestLi-Method` is compared case-INsensitively.** The docs show
  `PARTIAL_UPDATE`; LinkedIn's own JavaScript client sends `partial_update`. A
  case-sensitive comparison passes every hand-written curl and fails every SDK
  caller.
- **One numeric id backs a post's share, ugcPost and activity URNs**, and every
  path accepts all three. Real LinkedIn mints separate numbers; modelling that
  costs a resolution table and teaches an agent nothing.
- **Reactions are stored against the canonical activity URN.** `canonicalEntityUrn`
  is what stops one person liking the same post twice under two spellings. It can
  only finish the job for a post: a comment URN is canonical only once a row
  confirms both halves, so the two callers that hold a `db` — the reactions route
  and `injectReaction` — go through `requireComment` (or its BadRequestError
  twin) and rebuild the URN from `post_id + id`. `entity_urn` has no foreign key,
  so a near miss would be a row nothing ever reads back.
- **Every write is gated on the actor, including the ones that name none.**
  `requireActor` decides a create; `requirePostAuthor` decides a PARTIAL_UPDATE
  and a DELETE from the post's own author, because a patch body carries no actor.
  A stranger's post is 403 ACCESS_DENIED both times — a 404 would teach an agent
  the post does not exist, and a 204 would put a destroy in the audit log that
  the twin should have refused.
- **A DRAFT is 404 on every reader-facing path.** `requirePost` still resolves
  one (the posts resource serves it under `viewContext=AUTHOR` and publishes it
  by patch); everything else — socialMetadata, the comments finder and create,
  reactions, and the director's own beats — goes through `requirePublishedPost`.
  `viewContext=AUTHOR` is a VIEW, not a credential: both posts routes ask
  `mayActAs` whether the caller is the draft's author before revealing one, and
  answer the reader's 404 when they are not, because a 403 there would confirm
  the unpublished post exists. The demo seed cannot reach that branch — every
  draft in it is the page's — but a wire-seeded world reaches it immediately.
- **A reply may name its parent in either documented spelling**: the comment URN
  as the path segment, or `parentComment` in the body of a POST addressed to the
  post. They must agree when both are present; dropping the body field would put
  an agent's answer to a customer at the top of the thread with a 201. Threads
  are ONE level deep on every spelling — the REST route, the director's beats and
  the wire seeder all refuse a reply to a reply, because `listReplies` returns
  direct children only and a depth-2 row would be written and never read back.
  The route asks that through `requireThreadParent`, once, for both spellings:
  the rule was written twice, ran on the path segment only, and the body field
  quietly created depth-2 rows through four review passes.
- **DRAFT -> PUBLISHED is one-way.** `buildPatchInput` refuses
  `lifecycleState: "DRAFT"` on a post that is not already one. Backwards, the
  patch is a takedown — the post 404s on every reader surface and leaves the
  author finder — but `publishesDraft` is false, so the trail would read
  `Edited the post "…"` and `postDelete`, the verb that exists to make
  destruction visible, would never be written. It would also leave
  `published_ms` set, and a DRAFT carrying a `publishedAt` is the one state
  `shape.ts` and `sandbox/parse.ts` both refuse to express.
- **A patch that sets nothing is a 400, not a 204.** `buildPatchInput` decides
  that before it stamps anything: an empty `$set` used to flip
  `isEditedByAuthor`, write `Edited the post "…"` into the audit log the judge
  grades from, and reorder the company feed, which sorts on `lastModifiedAt`.
- Repo-wide, and they apply here: store functions take `db` first and use raw SQL;
  every route declares `runtime = "nodejs"` and `dynamic = "force-dynamic"`; every
  mutation goes through `runMutation` so the change and its audit row commit
  together; injected world events never write an audit row; route params are a
  Promise and must be awaited.

## How to add an endpoint

Mirror the real path under `app/rest` or `app/v2`, await `params`, wrap the body
in `handleLinkedIn` (which does the bearer gate, the version gate for `/rest/`,
the protocol gate, and error translation), shape the response through `shape.ts`,
write through `runMutation`, then add a smoke check and — for anything pure — a
unit test. Do not hand-build an error response: throw one of the factories in
`errors.ts` and let `toErrorResponse` do it.

## Wording provenance

Every error message is copied from LinkedIn's published documentation EXCEPT
these, which are the clone's own and are marked as such so nobody "corrects" the
copied ones into matching them:

- `missingFieldError` appends the field name; the real message does not.
- `fieldTooLongError`'s sentence.
- `versionDeprecated` and the two `LinkedIn-Version` messages in `auth.ts`.
- the `X-Restli-Protocol-Version` message in `auth.ts`.
- `"The requested post was not found."` and its siblings.
- the two `ACCESS_DENIED` sentences in `actor.ts` (LinkedIn's real permission
  errors carry the "Not enough permissions to access:" prefix; the explanatory
  second sentence is ours).

## Decisions a reviewer already asked about

- **The comments finder 404s on a thread with no comments.** That is LinkedIn's
  documented behaviour, not a bug: "If no comments or likes are available for a
  share, a request to fetch comments or shares returns 404 - Not Found." It is
  why the docs tell you to read `socialMetadata` first, and the seed keeps a
  post with zero engagement so the path is reachable.
- **`paging.total` is per-endpoint.** The posts finder and organizationAcls do
  not return one; the comments finder does. `buildPaging` takes it as optional
  and each route passes it only where the vendor does.
- **A repeat `POST /rest/reactions` upserts.** LinkedIn documents no semantics
  for a second CREATE from the same actor, so that is the clone's choice and the
  comment in `store/reactions.ts` says so rather than claiming it is the rule.
- **`commentary` is optional and may be blank on create.** LinkedIn's
  MISSING_FIELD table does not name it, and its own samples return live posts
  with `"commentary": ""`.
- **`POST /rest/reactions` stayed** after two reviewers proposed cutting it as a
  verb this phase has no reader for. The seed sets up a thread the agent is meant
  to handle, and acknowledging the comments it will not answer in full is part of
  handling it; the route header says so.
- **`GET /v2/me` was cut.** It answers the same question as `/v2/userinfo` about
  the same single member, and it is gated on `r_liteprofile`, which LinkedIn no
  longer provisions. `GET /rest/organizations/{id}` took its place in the budget,
  because an agent posting as a company page needs to be able to confirm which
  company that URN names.

## Out of scope

The partner-gated list lives in README.md, under "Not implemented, and not
coming". Anything on it must answer a LinkedIn-shaped 404 and must never be
faked plausibly.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
