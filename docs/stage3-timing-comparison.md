# Stage 3 offline timing comparison

Measured 14 September 2026 against the candidate engine. Ten matched-fixture tests
and the engine typecheck pass. This is an offline comparison using the real session
API, app adapters that preserve snapshot/audit shapes, scripted operations and an
explicit wall timer. It makes no model calls and does not establish live gateway or
Inspect integration, human-duration calibration, or completion of Stage 3.

The fixture checks four supplied workbook rows, then posts a handoff before tick 2
of a four-tick episode. A tick represents 15 simulated minutes; the compressed-wall
comparison uses 1,000 real milliseconds per tick. The business deliverable is the
same for batched edits, individual edits and a trace with six additional reads.
The last trace is permitted by this synthetic task; its extra reads are not evidence
of a calibrated accountancy workflow.

## Observed results

| Comparison | Result |
| --- | --- |
| Candidate with no latency, isolated 100 ms model/tool/world latency, and combined 1,000 ms latency | Identical admitted action timestamps, final rows, handoff, event order and five captured writes. Real elapsed time changes. |
| Compressed wall with no latency versus 1,000 ms model/tool and 100 ms world latency | The fast script completes all six operations. The slow script can execute only two before the day closes and produces no handoff. Remaining scripted operations are refused, not forced through after cutoff. |
| Candidate batch versus individual edits | Both consume 11 work units and receive the same handoff time despite using three versus six provider operations. Counting edited items removes a free batching advantage in this fixture. |
| Historical fixed-opportunity reference | With two provider opportunities at each frozen tick, the batch handoff falls in tick 1 and the individual handoff in tick 2. The latter misses the exclusive deadline. This reference is fixture arithmetic, not a recreation of the previous product runner or its 40-model-step backstop. |

The charge allowance changes the result of the permitted trace with more reads:

| Work units available per tick | Batch / individual handoff position | On time? | Handoff with six extra reads | On time? |
| --- | --- | --- | --- | --- |
| 6 | 1.833 ticks (11 units) | Yes | 2.833 ticks (17 units) | No |
| 12 | 0.917 ticks (11 units) | Yes | 1.417 ticks (17 units) | Yes |
| 24 | 0.458 ticks (11 units) | Yes | 0.708 ticks (17 units) | Yes |

All three candidate traces still produce the same correct final rows and handoff
at all tested allowances. The difference is lateness under the chosen work budget,
not whether the final business state is correct. Logical audit attribution agrees
with the engine's admission timestamps; the comparison does not substitute the
fixture's own arithmetic for captured action time.

## Decision supported by this evidence

Keep compressed wall as the existing default while exposing
`provider-operations-v1` as an explicitly experimental option after its integration
checks pass. The candidate removes infrastructure-latency dependence for these
scripted actions and avoids the tested batching advantage. Its deadline results
still depend on the work allowance. These tests do not justify calling 12 units per
tick realistic, selecting it because it favours a model, or interpreting a deadline
comparison without reporting sensitivity.

Those integration checks have since passed, and the decision above is the one that
was taken. The live matched pair, the acceptance-fixture map and the statement of
what remains unmeasured are in the
[timing verification record](stage3-timing-verification.md). Broader charge
profiles and practitioner review are required for claims about realistic work
duration. Multi-day case and reviewer-capacity behavior remains later work.

## Reproduction and evidence

From the repository root:

```bash
SONATA_TIMING_COMPARISON_OUTPUT="$PWD/.context/stage3-timing-comparison.json" npm run test -w packages/engine -- tests/timing-comparison.test.ts
npm run typecheck -w packages/engine
```

The optional output records every replay, its policy, work allowance, artificial
latency, accepted operations, logical action times, final-state summary and
captured-write count. It is saved in
`.context/stage3-timing-comparison.json`. The source fixture is
[`packages/engine/tests/timing-comparison.test.ts`](../packages/engine/tests/timing-comparison.test.ts).
No paid provider calls were made.
