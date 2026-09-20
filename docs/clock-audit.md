# External-session clock and lifecycle audit

Reviewed and changed on 11 September 2026 for the first serial Inspect pilot.
This is a bounded correction to the existing compressed-wall-time session, not
an implementation or validation of event-driven business time.

## Existing timing contract

- The business clock advances in the scenario's fixed simulated intervals.
- A compression factor maps those intervals to elapsed real time.
- Tick 0 opens the day immediately after setup. Tick N−1 opens its final work
  interval; the scheduled end is at boundary N.
- Agent activity is external. The session reads committed app audit rows at each
  poll, then injects scheduled events and runs recipient-scoped world reactions.
- Silence never ends a session. A solver that has no immediate tool call must
  distinguish waiting from ending its episode; Inspect integration owns that
  interaction, not the session timer.

The built-in runner instead gives an in-process agent a work opportunity on each
tick and advances after the agent returns. These policies remain different
experimental conditions. Neither is being renamed event-driven time.

## Defects corrected

| Defect | Changed behaviour | Regression evidence |
| --- | --- | --- |
| Natural completion occurred immediately after tick N−1, one interval before the advertised end. | Completion is scheduled at boundary N. The final interval remains open without an extra world turn. | A four-tick fixture runs for exactly four intervals and retains an action one millisecond before its scheduled end. |
| Stopping or ending a session took snapshots without reading actions since the last poll. | Finalisation drains audit rows and reported escalations once, extends the final record's capture window, and notifies the persistence callback again. | Between-tick and final-interval mutations survive in audit, steps, observations and action references; repeated finalisation does not duplicate them. |
| A world-provider exception could consume audit rows and inject beats, then lose the tick record containing that evidence. | The tick retains observed actions and delivered beats, with a `harnessError` identifying the failed world turn. Later ticks can continue. | A throwing director preserves a delivered beat and the agent's preceding mutation; the next tick does not repeat the mutation. |
| Stop could race setup, tick 0, a queued wake, or a tick scheduling its successor. Concurrent start calls could run setup twice. | One shared start promise and immediate scheduling closure serialize finalisation after setup/in-flight work. Later wakes are cancelled or ignored. | Concurrent-start, setup-cancellation, tick-0-cancellation and queued-wake tests finish once with no remaining timers. |
| Unreadable audit/snapshot requests were silently ignored. An unreadable initial cursor could later count setup writes as agent activity. | Runtime capture failures are recorded as harness gaps; an unreadable initial audit baseline fails setup rather than inventing attribution. Unhealthy preflight also fails setup. | Explicit gap and baseline-refusal tests retain honest capture status. |
| External harnesses could only stop with an `aborted` label. | `Session.finalize({ status, reason, error })` supports `done`, `aborted` and `failed` while sharing one final capture path. `stop()` remains an aborted wrapper. | A reported external provider failure retains partial work, reports the actual error and produces the same record for later cleanup calls. |

`onTick` is now explicitly an **upsert by tick index**. A final capture or lag note
can update an existing tick; storage must not increment totals a second time.

## Diagnosed accountancy pilot failure

The saved run `run_mtwuwolb_0bbd` failed at zero-based tick 14, with 15 tick records
retained. Its final record contains nine steps and a harness error. The final
agent call, trace sequence 107, contains the provider's explicit cause:

> prompt is too long: 213860 tokens > 200000 maximum

The same context-limit rejection appears in the recorded fallback-provider
errors. The preceding successful call reported 193,818 prompt tokens. The failed
request contained 124 messages, including 51 tool messages; several individual
tool messages were approximately 65,000 characters. Characters are not token
counts, but those stored tool results identify substantial context growth.

This establishes a context-capacity failure for that run, **not a tick or wake
failure**. It does not establish whether the earlier actions were correct. No
paid rerun was required or performed to diagnose it.

Evidence was read from the local saved artifacts:

- `apps/platform/data/runs/run_mtwuwolb_0bbd.json`
- `apps/platform/data/runs/run_mtwuwolb_0bbd.trace.json`

Those data files are local, gitignored artifacts. The error excerpt and measured
counts above preserve the relevant finding in this tracked documentation.

Before a longer model pilot, define and record a context/memory policy, reserve
headroom for tool results, and make context-limit termination distinguishable
from a model failing the business task. Do not silently introduce a helpful daily
summary or claim model comparison parity across different memory policies.

Done on 11 September 2026 for the built-in agent (`packages/engine/src/agent.ts`,
`DEFAULT_CONTEXT_POLICY`): a tool result from an earlier interval longer than
4,000 characters is replaced by its first 600 characters plus a stub that says
what was removed and how to re-read it; if the conversation still exceeds
360,000 characters (about 90k tokens), the oldest intervals are dropped whole and
a note under the system prompt names them. The current interval's results stay
intact, and the tick prompt says when trimming happened, so the trace shows what
the model saw. This is not a daily summary and adds no evaluator knowledge. The
Excel replica also now returns a receipt (revision and applied changes) for an
edit instead of the whole workbook; the browser path is unchanged. Runs before
this change carried every workbook read forward; compare within the policy.

Also on 11 September: two runs failed at preflight with "port 3950 is already in
use, but nothing healthy is answering". The Excel dev server was still listening
but no longer answered any request after about six hours; restarting it
(`npm run dev:excel`) cleared it. The cause of the hang was not established.

## Remaining boundaries and limitations

- **Finalisation is not access revocation.** The caller must stop issuing tools
  and drain its in-flight tool calls before explicit finalisation. The engine
  serializes world work; it cannot prevent a separate client writing directly to
  an app. Natural termination likewise requires an enforced cutoff before
  benchmark-grade atomic capture. Snapshot calls across apps are not one atomic
  transaction.
- **Completion is a harness decision.** Ending a solver early does not prove the
  simulated day elapsed. The API layer must preserve a partial/aborted outcome or
  an explicitly declared early-termination condition rather than letting a
  requested `done` label conceal missing business time.
- **Final capture does not generate another colleague reply.** Late committed
  actions are retained, and the record says no further world response was
  simulated. Do not grade an absent post-cutoff response as an agent error.
- **Poll time is not action time.** Ordinary external actions remain attributed
  to the tick that observed them. The final drain joins the last tick. Existing
  deadline-grading semantics need a separate review before fine-grained timing
  comparisons; this patch does not rewrite historical attribution.
- **Slow world calls still affect opportunities.** Deadlines are based on the
  original wall-clock grid. A slow reaction can delay subsequent polls and cause
  catch-up ticks with less available agent time. The artifact records lag; a
  matched timing-policy experiment remains required.
- **This does not add agent reminders or notifications.** The external agent
  still chooses when to inspect its tools. No evaluator rescue prompts or hidden
  memory summaries have been added. The historical idle indicator also counts
  the initial poll; it is diagnostic, not a measure of missed commitments.
- **No full external trace is invented.** Session steps still reflect audited
  mutations and reported escalations, not private reasoning or uncaptured tool
  reads. Inspect transcript linking and separate agent/world costs belong to the
  integration layer.
- **Abrupt process death is not checkpoint recovery.** This work handles normal
  async cancellation and errors; durable service restoration and resume semantics
  remain separate work.

## Verification

- Engine suite: 378 tests passed, including 43 session tests (10 new lifecycle
  regression cases).
- Engine TypeScript check passed.
- Whitespace/diff check passed for the changed session files.
- Saved provider failure was inspected directly without calling the model.

These engine regressions use deterministic adapters and a controlled clock. A
real app/API/Inspect integration run is a separate pilot acceptance check; this
audit alone does not claim that path has been exercised.
