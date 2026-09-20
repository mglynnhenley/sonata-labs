# Design Decisions

A consolidated record of the design decisions behind Sonata Labs, reconstructed
from the repository's history. Each entry states the decision, the reasoning
that produced it, and — where one exists — what was rejected or is still known
to be untrue.

This is the *why* document. For the *what* and *how*, see:

- **[AGENTS.md](../AGENTS.md)** — the invariants and the operational rules that
  keep being rediscovered (one path per job, verify by running, fetch before
  push).
- **[DESIGN.md](../DESIGN.md)** — the visual design system and its own decisions
  log.
- **[docs/reactive-world-plan.md](reactive-world-plan.md)** — the ten-step plan
  for making the world react to the agent, with a candid "what is still not true
  of it" section.

Nothing here is duplicated blindly from those files; this document exists to
gather the decisions that were only ever recorded in commit messages and to put
them in one place organised by theme rather than by date.

---

## 1. What the product is

**Decision.** Clone a business into fake Gmail, Slack and Calendar that share one
cast, one backlog and one clock; run an agent through a simulated workday inside
it; score how much of the job it finished without handing anything back to a
human.

**Reasoning.** The thing worth measuring is autonomy over a changing day, not
whether an agent can be tricked by a single trap email. A static fixture cannot
test whether an agent keeps working as the day changes, so the world has to move
on its own and answer back. The product's *only* output is a judgement, which is
why so many of the decisions below are about not overstating what that judgement
saw.

**Local-first.** Nothing leaves the machine. Each clone is a local Next app over
SQLite that speaks the real vendor API, so an agent built on the official
`googleapis` / `@slack/web-api` SDKs works against it with nothing changed but a
base URL.

---

## 2. Foundational architecture

### 2.1 Clone the real API surface, don't mock it

Each clone serves the vendor's actual REST shape (e.g. `/gmail/v1/*`,
Calendar v3) and is driven by the **official SDK via a `rootUrl` override**.
Semantics are faithful: `list` returns `{id, threadId}`, base64url bodies, live
label counts, default TRASH/SPAM exclusion, Gmail-shaped errors. `google-docs`
runs the real `googleapis` `docs_v1` client with only `rootUrl` overridden.

**Why.** An agent someone already has must work unchanged. A CRUD shell would
have been useless — so each clone models the hard part of its surface (attio's
versioned attribute values, google-docs' index-shifting inserts, google-ads'
restricted GAQL parser, linkedin's URNs and post lifecycle over the documented
subset only; partner-gated surfaces are named as such rather than invented).

### 2.2 The three-database model per clone

Every clone splits into a **working DB**, a **snapshot DB**, and a shared
**audit trail** (attached via SQLite `ATTACH` so a mutation, its history bump and
its audit row commit atomically).

### 2.3 A clone reset is one `copyFileSync`

`copyFileSync(snapshot.db, working.db)`. That single line is why every run starts
from an identical world and why two runs are comparable.

**This is the reason the clones stay on SQLite and will not move to Postgres.**
The half-wired `pg.ts` was deleted (it was imported by nothing and read as live —
exactly how the stand-in runner survived). The *schema* stays Postgres-ready, so
a future move is a connection string plus the async refactor `better-sqlite3`
forces — but that waits for a second user to justify a server. `data/*.db` is
gitignored, which is why a fresh checkout needs `db:init` and why a schema change
arrives through git without its tables.

### 2.4 Injected world events are not the agent's actions

The audit log is the agent's record, and grading reads it. Anything the harness
writes — seeded beats, injected mail, director replies — stays **out** of the
audit log. Grading depends on that boundary holding. (This is also why inspecting
a thread from outside the mailbox must not mark it read: doing so would write
rows into the very log being displayed.)

---

## 3. Monorepo and package boundaries

**Decision.** One npm-workspaces monorepo. `apps/*` are the clones and the
platform; `packages/*` are `core` (contracts + failure-mode catalog), `engine`
(clock, beats, director, agent loop), `judge`, `world`, `mcp`, `cli`, `ui`.

**Why consolidate.** Gmail and Slack were parallel branches sharing patterns by
hand and no code at runtime. Extending the judge to Slack and Calendar under that
layout meant three copies of the eval stack. The consolidation was a pure
structural change — both apps already resolved `data/` and `db/schema.sql` from
`process.cwd()`, which workspace scripts preserve — and Slack came in via
`read-tree` so its history survived.

**Package charter — `core` is contracts only.** No ambient `process.env` reads;
resolvers take an env object. `packages/core/src/ports.ts` owns the port numbers
(UI = API + 800, so the pairing is guessable) after five files each knew where a
twin lived and disagreed. Two env spellings are accepted with `SONATA_*` winning,
because centralising the numbers and centralising the names were both real and
neither should lose to the other.

**One cast, one union.** A single cast resolves to the same person in every
surface. `TwinName` is a closed union behind ~20 exhaustive `Record<TwinName, X>`
maps — treated as the *point* of the union, not an obstacle: widening it from
three to seven produced 100 type errors, and every one was a place that had to
say what the new surfaces mean.

---

## 4. World generation

### 4.1 The model writes prose only; code assembles everything else

Ids, addresses, timestamps, threading and membership are assembled in code. The
model writes subject/body prose. **This is what keeps seeds reproducible** — ids
are derived, never generated, so re-seeding a world is byte-identical and
yesterday's artifact still names today's deal.

### 4.2 Generation is six inspectable stages, not one call

`recall → rank → comprehend → timeline → options → compose`, each a
`Stage<In, Out>` with its own configurable model, its output recorded on a
`GenerationTrace`, and a declared fallback so a thin mailbox degrades rather than
failing the run. `now` is injected, not read inside a stage, so the date logic is
testable. This replaced a single opaque LLM call after two real defects (anchor
selection picking the wrong thread; anchors carrying no timestamp).

### 4.3 Cast in code; write each character alone

The world casts deterministically in code — from who was addressed, whose reply
is due, and who a beat named — then calls each character *alone*, with only what
they could have seen. **A character cannot leak a channel that was never in their
prompt** — a property a test can hold, rather than a rule a model can forget. This
replaced one-call-writes-everyone, where six people wrote like one person doing
impressions and a Gmail-only character was written by something that had read
`#ops`.

### 4.4 Storyline writers with a shared spine

A company is written by a **spine pass** (the channel roster and the canonical
facts every writer must spell the same way, with who knows them), then each
**storyline** is written across all three surfaces at once, in parallel, and
merged in pure code. Splitting by surface was rejected and stays rejected: seven
surfaces written separately is what makes one company read as seven unrelated
fixtures. This costs more per company (one call becomes a spine + one per
storyline + an ambient pass) — the trade the bigger backlog is bought with.

### 4.5 The reactive world (the director)

Once a tick, the director reads what the agent *observably did* (from each
clone's audit delta) and answers in character. It reads the agent's **prose**,
not just audit metadata like `Sent "Re: SLA" to dana@…`, so it can tell a
thorough reply from a useless one instead of guessing. Because it works from the
audit delta, it needed no change to react to an external MCP-driven agent — that
agent's actions land in the same log.

### 4.6 Adaptive beats — keep the slot, change the words

A scripted beat may carry `adapt`: a condition asked in the *scorer's* words, and
the facts its rewording must keep. When the condition holds, the person the beat
was always from rewords it in their own voice. So a chaser complains about what
the agent actually did, not about a silence that did not happen.

**What deliberately does not change: whether the beat fires.** It happens on its
own tick in every run, whatever the agent did. That is what keeps two models
comparable — and it is also just true of people (nobody goes silent because you
replied). The beat still mints its ref, so every criterion binds exactly as
before.

Safety catches, because failure here is invisible: the condition reuses the
judge's own checkers (one definition of "replied", so the world can't escalate
about a silence the checklist scores as a reply); a rewrite that drops a declared
fact is thrown away for the authored text; anything undecided or failed falls
back to the authored words, never to silence.

### 4.7 What generation stays fixed on

The plan's fixed skeleton — the beat schedule, the scoring rules, and the pure
world-assembly function — is what lets two models be compared. Beats *adapt their
wording* rather than cancelling.

---

## 5. Scoring and judging — the core of the product

This is where the most decisions cluster, because a judgement that overstates its
evidence is worse than none.

### 5.1 Hybrid grading: a deterministic checklist + an LLM judge

Deterministic assertions run over the audit log and final state; an LLM judge
handles the qualitative residue against a catalogued set of failure modes. The
**assertions stay behaviour-only** — the judge sees the agent's reads (with
totals, so it can tell targeted reading from a sweep), the deterministic rubric
does not.

### 5.2 A criterion is passed, failed, or notApplicable

`notApplicable` leaves *both* numerator and denominator. A criterion that holds
only because nothing happened is not evidence of good work, so negative criteria
can no longer pay out in full to a do-nothing agent. Vacuity is *derived* from
whether the checker observed anything, not from a hand-maintained id list that
would rot.

### 5.3 Absent is not zero

A run that did not execute carries **no score at all** — absent, not zero. Zero is
a claim about performance; absent is a claim about knowledge, and only the second
is true of a run whose agent never touched a twin. Absent also cannot be silently
averaged into a benchmark.

### 5.4 Refuse a verdict the evidence does not support

Verdicts gain `inconclusive`. A run whose must-dos were never *decided* cannot
pass — the musts are what the verdict is about. A score travels with its
decided/asked counts, so "100%" can't be quoted without "of 1 decided, 4 asked."
Generated criteria **must bind** (ref/target validated against the scenario's
actual beats before storage) — a criterion that can't be evaluated should be
impossible to author, not discovered on a shared report later. A checker that
can't decide a criterion on its own terms **refuses** rather than answering a
narrower question and reporting it settled.

### 5.5 Drafts are not sends

A `replied` criterion FAILS when only a draft exists, with evidence naming the
unsent draft. The distinction is the exact behaviour a real demo run turned on
(an agent that drafted four refund approvals, sent none, and claimed it had
processed them).

### 5.6 Say what you did not measure

Every gap the harness has is the harness's, not the agent's, and must be visible
as ours:

- **Coverage is computed and carried on the verdict** — a reader knows when prose
  findings were formed on part of a day (the judge once read 200 of 304 steps and
  kept the *morning*, discarding the afternoon where deadline criteria live).
- A **truncated day** (beats that never fired) is a harness defect; a criterion
  whose subject never arrived is not the agent's failure, and the judge is told
  which beats never fired.
- A **missing snapshot** is named in the artifact (which twin, and why) instead
  of vanishing into an empty map that looks like a day where nothing happened.
- The closed criterion `kind` vocabulary refuses an unknown kind at authoring
  time rather than falling through to "no checker exists" silently on a `must`.

### 5.7 Show the judge the end state, not just the diff

The after-snapshot reaches the judge as its own section, rendered apart from the
diffs so it can't read as a second diff. "No customer should be left without a
response" is a claim about where things *ended up*, and what an agent leaves
untouched is exactly what a change-log cannot show. Bounded by the spec's own
clock (relevance), not a flat cap — raw snapshots were 120k characters, 85% of it
calendar events from days the run never touched.

### 5.8 A character's opinion is evidence, and may not move the score

What a character made of the agent's reply reaches the judge as **evidence,
labelled as the world's opinion**. It may not move the checklist, the verdict, or
the benchmark's autonomy number — these are cheap in-world models with a pull
toward drama, and a benchmark that let them score would be measuring the world.

### 5.9 Runs are self-contained artifacts

Both snapshots per twin plus the audit window are persisted, so a run is
re-checkable and re-judgeable **from the file alone, months later**, with nothing
live. Pages re-derive the checklist from the artifact rather than mapping stored
booleans forward, so a figure on screen is what today's code computes.

### 5.10 Benchmark aggregation is by (model, scenarioId)

Within a scenario the ordering is monotone in agent work; across scenarios it is
not comparable, so aggregation means by `(model, scenarioId)`. Prompt caching is
what makes a full day affordable at all — an append-only message array re-sent
uncached grows cost with the square of day length (~$12 for a 32-tick run);
identical bytes reach the model, so caching cannot move a score.

---

## 6. Connecting an agent (MCP)

**One stdio MCP server fronts all three clones** — 28 tools, `gmail_*` /
`slack_*` / `calendar_*`, plus `sonata_whats_new` for cheap "what changed since I
last looked" polling.

**The tools are derived from `packages/engine/src/tools`, not copied**, so what an
agent can do and what the benchmark measures cannot drift apart.

**Sessions vs episodes.** The world can run without driving anyone: a session
advances on wall-clock timers with a compression factor, firing the same beats
and the same director as a scored episode. The only difference is who acts.

---

## 7. Authentication

**OAuth is an option, not the door** (`SANDBOX_AUTH`, token by default). A real
OAuth2 authorization-code server (PKCE S256, per-route scope enforcement,
Google-mimicking consent screen) sits in front of `/gmail/v1/*` for credibility
as a standalone product — but making it mandatory broke internal callers and put
a consent screen in front of your own sandbox inbox. `token` mode restores
static-token access via one fallback in `authenticate()`; `oauth` mode is the
full third-party flow. The API reports the active mode on `/api/health` and is
the single source of truth.

**One auth path: `createTwinHttp`.** The harness mints a provider token through an
admin-gated bridge and re-mints on 401; an MCP-connected agent and an
engine-driven agent authenticate *identically*. A second exchange written
anywhere is how the two paths drift apart — which they did, twice, each time
leaving Gmail 401ing while typecheck and 1100+ tests stayed green.

**The Gmail UI is its own OAuth-client service** (`apps/gmail-ui`) with zero DB
access, talking to the API as a genuine third-party client over a BFF. If a view
can't be expressed over the public API, the fix is a scoped API addition, never a
DB backdoor.

---

## 8. Engineering invariants (process discipline)

These are in [AGENTS.md](../AGENTS.md); summarised here because they *are* design
decisions, arrived at by breaking things.

- **One path per job.** Two ways to run a day, resolve a key, or authenticate have
  each drifted and broken silently. Wire the first through instead of writing a
  second.
- **Delete dead code; do not flag it.** The stand-in runner survived for weeks
  because it looked live — a seeded RNG decided whether the "agent" acted while
  1070 tests passed and 27 saved runs had $0 model spend. `pg.ts` was deleted for
  the same reason.
- **Verify by running, not by compiling.** Every serious defect here passed the
  type checker and the tests. Call the running server, read the artifact, check
  the real model spend.
- **Measure the agent, not the harness.** A report that presents our defects,
  our truncation, and the agent's genuine failures identically is the whole
  product broken.
- **Fetch before you push** — several Conductor sessions share `main`; a rejected
  push once would have wiped a colleague's OAuth work. Push small and often.
- **A schema change arrives without its database** (`data/*.db` is gitignored);
  run `doctor` / `db:init` after a merge.
- **The CLI is `npm run sonata -- <command>`, never `npx sonata`** — `sonata` is
  an unrelated published package, and `npx` would run the stranger's before this
  repo's after install.

---

## 9. Visual design system

Full detail in [DESIGN.md](../DESIGN.md); the load-bearing decisions:

- **Identity (v3): Satoshi + petrol + warm paper.** Deliberately replaced the
  AI-default cream + Instrument Serif italic + Inter + muted slate blue, which the
  user called out as the uniform of machine-made UI. Register set by the
  ElevenLabs agent-console reference after category research (Braintrust, Modal,
  Langfuse) and three rounds of iteration. Satoshi is vendored (Fontshare
  licence) so nothing loads from a CDN.
- **Rejected on the way** (kept in DESIGN.md's log): a two-surface light/dark
  system (one surface, lower maintenance); a dark-pine sidebar + volt accent (the
  reference was light and calm).
- **One petrol accent, rationed.** "Running/live" is the loudest thing on any
  page, so nothing else borrows petrol. State uses muted sage/terracotta, never
  saturated traffic lights. Light-only; `color-scheme: light`.
- **Only print numbers the engine actually computes.** Repeatedly, the design
  handoff drew metrics (judge-out-of-five, policy adherence, environment seeding,
  escalation counts) the engine does not produce. Each time, the honest narrower
  figure was shipped and the invented column cut — "a rail that quietly invents a
  metric is worse than a shorter rail." Horizon and coverage *were* eventually
  computed, once it turned out the ingredients (`tick`, `total_ticks`,
  minutes-per-tick) were already in the schema.
- **One scale for everything.** 25 font sizes across 441 sites collapsed to an
  11-step `--text-sn-*` scale (each owning its line-height); 8 icon sizes to 4;
  four named spacing tiers (section 40 / block 24 / group 16 / item 8). A panel
  names itself (title/subtitle/actions live in the card), so a page reads as a
  stack of named panels.
- **AA contrast is a hard floor.** The subtle grey was darkened from `#8a908d`
  (3.01:1) to `#6b716e` (4.61:1) because it appears in 185 sub-13px places;
  per-state hint colours were fixed where a pale-petrol selected surface pushed
  the grey back under AA.
- **Nav must never orphan a route.** `/sessions` and `/connect` were reachable
  only by typed URL once; `routes.ts` records why they must never fall out again.

---

## 10. Naming

The repo was renamed from its first artifact (a Gmail clone) to **sonata-labs** —
only one of the (now seven) clones is Gmail, and the product is Sonata Labs. The
`sonata` bin name is kept only so an installed checkout keeps winning the `npx`
race against the unrelated `sonata` package on the registry; the canonical,
unclaimed name is `sonata-labs`. Neither belongs in a document that tells a user
what to type — that is always `npm run sonata`.

---

## 11. Known-deliberate gaps (recorded, not fixed)

The codebase's doctrine is to record what is untrue rather than paper over it.
Current standing items:

- **Seven clones ship; three are scored episode twins.** Attio, Google Docs,
  Google Ads and LinkedIn are callable API surfaces with adapters but not yet a
  full scored day. `BY_TWIN` uses an `AWAITING_CHECKER` sentinel for them —
  distinct in the table, countable later — rather than disguising the debt as a
  decision.
- **A character's assessment is in the run JSON and the judge prompt but is not
  yet rendered on the results page.**
- **`sonata_whats_new` windows the calendar on wall-clock time** while scenarios
  run on a simulated date, so calendar changes may not surface to a polling agent
  (`whatsNew.ts`).
- **The storyline-writer cost increase is unmeasured against a real model**, and
  two prompt changes mean runs are not comparable across that work — compare
  within an era, not across it.
