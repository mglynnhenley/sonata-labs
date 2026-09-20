# Stage 3 timing verification and policy decision

Scope: the timing experiment specified in the [timing contract](stage3-timing-contract.md),
measured against the implemented engine on 15 September 2026. It records what the two
policies do in Sonata's own product path. It does not establish that either policy's
assumptions match real accountancy work; no practitioner has reviewed the charges.

## Decision

**`compressed-wall-time` remains the default. `provider-operations-v1` ships as an
explicitly experimental option**, selectable per run in the dashboard, the `/api/runs`
and `/api/sessions` bodies, and the Inspect task's `timing_policy` parameter. A run saves
the policy it used, and both the run page and the exported report name it: the experimental
clock carries its allowance and a statement that the run is not comparable with a default
one. Runs filed before the experiment declared no policy and say nothing rather than
assuming the default on their behalf.

Why not make the candidate the default yet:

- Its deadline results move with the work allowance, and no measurement justifies 12
  units per tick over 6 or 24. See the sensitivity table in the
  [offline comparison](stage3-timing-comparison.md).
- Its charges are declared parameters. A read costing 1 unit means 75 simulated seconds
  at the default allowance; nobody who does this job has agreed to that.
- The default is what every existing run and saved report was produced under, and it is
  the policy that measures a whole deployed agent system under time pressure — which is
  a real thing to want to measure, not a defect.

Why expose it at all: under the candidate, business time comes from the agent's own app
requests, so provider latency, retries and host contention stop moving the deadline.
That is the property a model comparison needs, and it is now verified live rather than
only in fixtures.

**Results produced under the two policies are not comparable.** That is the reason the
policy is named on every surface a reader reaches a conclusion from, rather than only in
the artifact.

## What the two policies did on the same script

A matched pair through the normal Inspect path and the run's Docker workplace, replaying
one fixed tool script with `mockllm` — no paid model calls, no agent decisions to vary.
Evidence: `.context/stage3-live-timing-verification.json`, Inspect logs in
`.context/stage3-live-inspect-rerun/`.

| | `provider-operations-v1`, 12 units/tick | `compressed-wall-time`, ×60 |
| --- | --- | --- |
| Run | `sess_mu2g3hng_c4jo` | `sess_mu2g46ou_94bw` |
| Real time elapsed | 3.8 s | 90.5 s |
| Operations admitted and charged | 8 (reads 1 unit, writes 2) | not applicable |
| Gmail send attributed to | 08:06:15, interval 0 | interval 1, no operation attribution |
| Excel edit attributed to | 08:10:00, interval 0 | interval 1, no operation attribution |
| Slack handoff attributed to | 08:13:45, interval 0 | interval 2, no operation attribution |
| Business outcome | same three mutations, same verdict | same three mutations, same verdict |

The scripts are identical, so the placement difference is entirely the clock. Under the
candidate, each mutation lands at its charged completion time and the ledger names the
operation that put it there. Under the baseline, the same three writes spread across
three intervals because of how long the provider and the host took — which is the
sensitivity the baseline is expected to have, and the reason it is labelled rather than
corrected.

Both runs scored `inconclusive`. The fixture is a partial script on a six-interval
truncated day; agreement between the policies is the point, not the score.

## Acceptance fixtures

The contract's fixtures, and where each is checked. All are offline unless marked.

| Fixture | Where |
| --- | --- |
| Latency invariance | `packages/engine/tests/timing-comparison.test.ts`; real HTTP with injected provider latency in `apps/platform/tests/timing-controller.test.ts` |
| Deadline boundaries, hard end, single capture | `packages/engine/tests/session-timing.test.ts` — boundary events precede a completion at that boundary; an operation completing at or after day end is refused and mutates nothing |
| Wait across competing work | `session-timing.test.ts` — a wait visits every intervening interval, a competing private event is processed without waking the agent, and an agent-set wake beats a later notification |
| Notification race | `session-timing.test.ts` — an arrival during a reserved operation is neither lost nor replayed; owner-authored and failed deliveries do not notify |
| Alternative workflows | `timing-comparison.test.ts` — batched edits, individual edits and a read-heavier trace reach the same final rows and handoff |
| Budget sensitivity | `timing-comparison.test.ts` at 6, 12 and 24 units per tick |
| Errors and retries | `session-timing.test.ts` — an app-rejected attempt is charged, a replay of the same reservation is refused and free, a fresh attempt is charged again, and an uncertain capture is recorded as a harness gap rather than attributed |
| Resource and finalisation limits | `session-timing.test.ts` — a guard's own stop reason and partial evidence survive, unreached intervals are not filed as having happened, and repeat finalisation does not double-count. Real-time and spend guards live in `apps/platform/src/lib/engine/inspect.ts` and stop the run with their own reason |

Regression state at the time of this record: 2,519 workspace tests, 58 Inspect tests and
all workspace typechecks pass. The two live runs above made no paid provider calls.

## What this does not establish

- That 1 unit per read and 2 per write resemble human effort. They are experimental
  parameters pending practitioner review.
- That either policy is validated for published model comparisons. One scripted fixture
  is not a controlled comparison, and the scenario and grading are still unreviewed.
- Anything about multi-day clocks, reviewer capacity or case branching. Those are
  Stages 4 and 5.
- Notification coverage beyond owner-delivered Gmail, Slack and Calendar updates. Other
  apps do not wake the agent; a run relying on one must poll.

## Reproduction

With the platform and its services running:

```bash
# Offline comparison, writes the full replay record.
SONATA_TIMING_COMPARISON_OUTPUT="$PWD/.context/stage3-timing-comparison.json" \
  npm run test -w packages/engine -- tests/timing-comparison.test.ts
npm run test -w packages/engine -- tests/session-timing.test.ts
npm run test -w apps/platform -- tests/timing-controller.test.ts

# The live matched pair. Repeat with --timing-policy compressed-wall-time.
.context/inspect-venv/bin/python -m sonata_inspect.smoke \
  --platform-url http://localhost:3000 \
  --episode-id tax-reporting-workbook-day \
  --actions integrations/inspect/fixtures/tax-workbook-known-success.json \
  --timing-policy provider-operations-v1 --work-units-per-tick 12 \
  --seed-world --ticks 6 --log-dir .context/stage3-live-inspect-rerun
```
