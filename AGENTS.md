# AGENTS.md

Read this before working anywhere in this repo. The per-app files
(`apps/gmail/AGENTS.md`, `apps/slack/AGENTS.md`) cover their own surfaces; this
covers the things that have actually gone wrong across the whole thing.

## What this is

Sonata Labs. Clone a business into fake Gmail, Slack and Calendar that share one
cast, run a scenario as a simulated workday on a tick clock, and score how much
of the job an agent finished without handing it back to a human.

```
apps/gmail  apps/slack  apps/calendar   the clones (SQLite, local, ports 3101/3200/3400)
apps/platform                           the dashboard + CLI (port 3000)
packages/core     shared types, the failure-mode catalog, scoring rules
packages/engine   the tick clock, scripted beats, the director, the agent loop
packages/judge    checkers, the deterministic checklist, the episode judge
packages/world    one sentence -> a coherent company across all three clones
packages/mcp      the stdio MCP server an outside agent connects through
packages/cli      `sonata` — doctor, init, up/down, then straight through to the above
packages/ui       the design system
```

## Several sessions share this repo — fetch before you push

There are multiple Conductor workspaces on this repo, each a separate session,
all pushing to the same `main`. A push that was rejected once already would have
wiped a colleague's OAuth work.

```bash
git fetch origin && git merge origin/main   # then run the tests, then push
```

Push small and often. The damage potential today came entirely from letting
eighteen commits pile up locally before trying to land them.

## A schema change arrives without its database

`data/*.db` is gitignored, so pulling a schema change gives you the new
`schema.sql` and none of the tables. That is not theoretical: the OAuth work
added three tables, and every Gmail call returned 500 —
`no such table: oauth_tokens` — until the schema was applied.

```bash
npx sonata doctor               # names the clone, the missing tables and the fix
npm run db:init -w apps/gmail   # safe: every statement is CREATE TABLE IF NOT EXISTS
```

If a clone starts 500ing right after a merge, this is why. `sonata doctor` reads
every clone's `data/*.db` against its committed `db/schema.sql` and changes
nothing, so it is the cheapest first move after any merge.

## Verify by running it, not by compiling it

Every serious defect in this codebase passed the type checker and the tests.

- The dashboard's "Start the day" ran a seeded random number generator for weeks.
  `runner.ts` said so in its own header; nobody read it. 1070 tests passed
  throughout, and 27 saved runs had zero model spend.
- After the OAuth merge, typecheck and 1117 tests were green while the MCP
  connector 401'd on every Gmail tool.
- The judge read 200 of 304 steps and kept the morning, discarding the afternoon
  where the deadline criteria live.

So: call the running server, read the artifact, drive the real path. `curl` the
route. Check the run's actual model spend — a run that finished in 15 seconds at
$0 did not happen.

## Invariants worth defending

**One path per job.** Two ways to run a day, two ways to resolve an API key, two
ways to authenticate to a clone — every one of these has already drifted and
broken silently. If you find yourself writing a second implementation, wire the
first one through instead.

**Delete dead code; do not flag it.** The stand-in runner survived because it
looked live. An unused module or a disabled branch is a defect waiting to be
mistaken for a feature.

**A clone reset is `copyFileSync(snapshot.db, working.db)`.** That single line is
why every run starts from an identical world and why two runs are comparable.
It is the reason the clones stay on SQLite and will not move to Postgres.

**Say what you did not measure.** A missing snapshot, a truncated day, an
undecidable criterion, a judge that read part of a run — each must be visible in
the report as ours, not scored against the agent. The product's only output is a
judgement; a judgement that overstates its evidence is worse than none.

**Injected world events are not the agent's actions.** The audit log is the
agent's record and grading reads it. Anything the harness writes must stay out.

## Commands

```bash
npm install                  # workspaces, from the root — before any `npx sonata`
npx sonata doctor            # every prerequisite, and the fix for each
npx sonata up                # dashboard :3000 and the three clones, supervised
npm run dev:platform         # or one at a time: dashboard  :3000
npm run dev:gmail            # clone      :3101
npm run dev:slack            # clone      :3200
npm run dev:calendar         # clone      :3400
npx sonata status            # twins, models, recent runs
npx sonata world create "a 30-person support desk"
npx sonata run <scenario> --model anthropic/claude-haiku-4.5 --ticks 4
```

`npm install` first: `sonata` is this repo's own bin, and `npx sonata` in an
uninstalled checkout fetches an unrelated package of that name off the registry.
`npm run sonata -- <command>` is the same CLI by a path that cannot.

Tests and typecheck are per workspace: `npx vitest run` and `npx tsc --noEmit`
inside each. Never run `next build` while a dev server is up — they fight over
`.next` and leave it corrupted.

## Environment

`OPENROUTER_API_KEY` is read from `.env` at the repo root, and the name matters —
`OPEN_ROUTER_KEY` is silently ignored. A key saved through Settings lives in
`platform.db`, which is a different source; code that needs one should go through
the settings helper rather than reading `process.env` directly.

Costs are real. A 4-tick smoke run is roughly $0.15 and a 32-tick day about $2.
Price a run before starting one, and never launch a benchmark matrix without
asking.
