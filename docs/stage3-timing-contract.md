# Stage 3 timing contract

Draft for the timing experiment, 14 September 2026. This document specifies the
comparison to build and the evidence needed to choose a policy. It does not claim
that the candidate or the checks below are implemented or that a timing policy has
been validated by an accountancy practitioner. Implementation results belong in a
separate verification record.

## Decision and scope

Compare the existing compressed-wall-time session with an action-based candidate
through the same Inspect task, engine, private workplace, scenario and assessment
path. Keep the current default until the comparison is reviewed. Preserve existing
pilot artifacts and their original timing configuration.

The question is whether an explicit work budget gives a more useful, reproducible
test of prioritisation and follow-up than fitting model calls inside a compressed
real-time window. Neither policy measures human task duration by itself.

The original Vending-Bench assigns tool-dependent simulated durations of 5, 25 or
75 minutes, or 5 hours. That is a precedent for declaring a simulation rule, not a
calibration for Sonata's accountancy tasks. Our first action durations must be
labelled **experimental work charges, not human-validated durations**. The selected
candidate uses abstract work units rather than calling those charges human minutes.
[Original Vending-Bench, section 2.3](https://arxiv.org/html/2502.15840v1)

Separate four quantities in every comparison: simulated calendar time, charged
work, actual execution time, and model cost. An agent operating across three
simulated days has not thereby completed three days of human labour or run reliably
for three real days. See the [research notes](long-horizon-benchmark-notes.md) for
the broader precedents and qualifications.

## Policies under comparison

| Policy | What advances business time | Meaning and limitations |
| --- | --- | --- |
| Current compressed-wall-time session | Elapsed real time mapped onto the scenario's tick grid using the declared compression. | Model, tool and world latency can change the available work opportunity. Record compression, tick length and scheduling lag. This remains the product baseline. |
| Historical tick baseline | An in-process agent opportunity followed by the next tick. | Keep as a documented or deterministic fixture reference. Its model-step backstop was not a human-duration budget. Do not restore a second product runner to reproduce it. |
| Candidate `provider-operations-v1` | Declared charges for provider API operations; explicit waits advance through scheduled events. | Model inference and infrastructure latency do not consume business time. Results depend on the charge profile and workflow granularity; measure that sensitivity. |

The [clock audit](clock-audit.md) records the baseline and its earlier corrections.
Today `wait_for_update` waits for the next clock interval and returns the public
clock; it does not reveal a future event or a hidden colleague state. `finish_work`
declares that the agent will take no more actions while the world continues to the
scheduled end. Keep these meanings distinct from cancellation, failure and budget
exhaustion when introducing candidate tools.

## Candidate action contract

Use one engine-owned business clock and the existing event, observation and final
capture paths. Inspect continues to orchestrate the tested agent. Do not add an
independent Python clock, copy the colleague simulator, or infer action completion
from a later poll when an explicit dispatch boundary is available.

The initial `provider-operations-v1` profile charges 1 unit per provider read and
2 per write, counting supported batch operations by their items. The base budget
is 12 units per world tick; comparison fixtures use 6, 12 and 24. A partial budget
advances to the corresponding fractional tick, so multiple operations do not all
receive the same timestamp. These numbers are experimental parameters, not a
measured conversion from API requests to human effort. One MCP tool can make
several provider requests; those requests, not just the outer tool name, consume
the budget.

Admission through the provider gateway must cover direct HTTP as well as MCP
requests. Trusted host admission precedes dispatch, and acknowledgement follows
execution before another operation advances time. Unclassified operations must
not silently become free. Reads and unsuccessful agent attempts need a declared
charge as well as successful writes. OAuth refresh is a bounded maintenance
exception with no business charge; it does not expose business observations.
Harness observation,
snapshot capture and world injections are not agent work and do not enter its audit
log. Pure waiting consumes calendar time without pretending it was active work.

Before executing a tool, reserve its declared work charge once. The proposed first
experiment treats the reserved completion time as the action's logical commit
time: process all earlier scheduled events, then dispatch the tool if the workplace
is still open. A reservation that reaches or exceeds the hard episode end must not
dispatch a late write. This rule deliberately approximates work as an atomic
operation; it does not model interrupted drafting or partially completed edits.
Record that limitation rather than supplying intermediate work retrospectively.

Serialize operations in the initial fixed harness. Any later parallel action
policy must state whether work adds, overlaps, or draws from a capacity limit;
network concurrency must not accidentally grant free simultaneous labour. An
identical dispatch reservation cannot be charged or executed twice on transport
retry. A new agent-requested retry is a new attempt. If the harness cannot establish
whether a write committed, retain the uncertainty as an evaluation fault.

Record expected app validation failures separately from infrastructure failures.
An invalid recipient or malformed agent request can consume the declared attempt
charge. A failed gateway, missing database or lost provider response cannot be
silently presented as agent-caused lateness. Retain the trace and apply the existing
incomplete-evidence rules when the intended opportunity cannot be established.

Real execution time, turn limits and monetary limits still bound a candidate run.
They remain resource guards, not simulated business deadlines. Hitting one must
retain its actual stop reason and partial evidence. A long model call cannot run
forever merely because simulated time is paused.

## Events, deadlines and waits

Advancing time means visiting every intervening event in deterministic order, even
if the agent is waiting for a particular person or until tomorrow. Other cases can
receive evidence or miss deadlines during that wait. An idle jump cannot erase
those consequences. Initially, reuse authored tick events as scheduled boundaries;
a general workflow interpreter and multi-day colleague capacity are later stages.

The candidate must define simultaneous-event ordering before it is accepted. The
proposed first fixture convention is that scheduled events and deadline closure at
a timestamp precede a new agent action at that timestamp. A deadline window is
therefore half-open: an action must commit before the stated cutoff. This is an
explicit experimental convention, not a claim about the meaning of every real
business deadline. A different convention requires a different policy version and
the same before/at/after tests.

An agent may wait for the next public update or set a wake time. Advance to the
earliest relevant incoming notification, requested wake, or episode end, processing
all intervening events. Ordinary internal bookkeeping and hidden evaluator state
must not wake the agent or be revealed by the wait result. A scheduled check-in
must be agent-requested or declared as part of the public harness policy.

An incoming email, message or other authorised app notification may wake the agent;
an unanswered request does not entitle it to an evaluator-written reminder. Return
only the public time and permitted notification information, then let the agent
read the business apps. Stable event identifiers or cursors must prevent duplicate
wakes and missed updates when an event arrives between observation and waiting.
Repeated polling must not create unlimited free work at a frozen timestamp.

The first candidate's notification scope is owner-delivered Gmail, Slack and
Calendar updates from another actor. Agent-authored updates do not wake it. Other
apps do not yet have equivalent notification coverage; record that limitation
rather than promising that every useful app change will wake the agent.

`finish_work` must continue to mean no further agent actions, not successful case
completion. Process the remaining scheduled world consequences through the defined
episode end. Finalisation closes tool access, captures committed actions once, and
records in-flight or missing evidence. It must not generate a helpful final
colleague reply just to complete the report. User stop and harness failure retain
their distinct lifecycle paths.

## Proposed deterministic acceptance fixtures

These are test designs, not passing results. They require no paid models. Use small
scripted Inspect actions through the actual private workplace for integration
checks, with engine-level replays for precise boundary cases.

| Fixture | Setup | Required observation |
| --- | --- | --- |
| Latency invariance | Replay the same reads, message, edit and wait with 0, 100 and 1,000 ms of injected model, tool and world latency. Keep logical input events identical. | The candidate has identical action/event ordering, simulated timestamps, deadline results and final business state. Real duration may differ. Record the baseline's latency sensitivity separately; it is not expected to be invariant. |
| Deadline boundaries | Schedule a cutoff at 09:15 and reserve otherwise identical actions finishing at 09:14, 09:15 and 09:16. Repeat at the hard episode end. | Before/at/after outcomes follow the declared tie rule. No action reaching the hard end mutates the apps. The last eligible action appears exactly once in capture. |
| Wait across competing work | Case A's reply arrives at 10:30; Case B closes at 10:00. The agent waits at 09:30 for A or requests an 11:00 wake. | B's deadline is processed; A's permitted notification can wake the agent at 10:30. Waiting does not remove B or create a reminder about it. An agent-set earlier wake wins. |
| Notification race | Deliver an authorised update between the last observation and the wait request; repeat the wait using the same observation cursor. Include an unrelated private update. | The authorised update is not lost or delivered twice as a new wake. The private update neither leaks nor supplies a useful wake signal. |
| Alternative workflows | Produce the same accepted workbook and handoff using batched edits, individual edits, and a valid different order of preparation and communication. | All valid paths succeed with a generous work budget. Near the cutoff, report differences caused by batching, call counts and scheduling; do not mark a valid business workflow intrinsically wrong. |
| Budget sensitivity | Replay those workflows with 6, 12 and 24 units available per world tick, and examine a declared alternative read/write ratio separately. Preserve the same business criteria. | Publish charged work and deadline outcome per profile and workflow. Explain any reversal; do not select charges solely because they produce a desired model ranking. |
| Errors and retries | Inject an app validation error, a retry of the same reserved operation, a new agent attempt, and a transport failure with uncertain commit. | Charges and executions match the declared attempt rule; no duplicate writes. Uncertain commit is retained as a harness evidence gap. |
| Resource and finalisation limits | Exhaust a turn, wall-time or spend guard; cancel during a reserved operation; repeat finalisation. | The report preserves the distinct stop reason, available evidence and cleanup. Resource failure is not renamed a simulated deadline miss; final capture does not double-count. |

Fix expected business outcomes independently of the timing implementation. Preserve
the initial obligations and permit valid alternative workflows. A pending case
awaiting unavailable evidence must remain distinguishable from an agent that never
requested it; a response delay introduced by the fixture is not an agent error.

The latency fixture compares identical logical actions, not different decisions
made by a stochastic model. When comparing the baseline, report both the attempted
script and the subset that could execute before cutoff. Do not force a completed
baseline trace after its deadline to manufacture matched outcomes.

## Evidence and decision gate

Each run needs the policy version, full charge profile and fingerprint, initial
clock and hard end, seed/scenario identifiers, wake policy and resource limits.
Retain trusted records linking action reservations to tool dispatches, logical
completion times, intervening events and stop reasons. Record actual request
latency separately. The ledger is evidence for the evaluator; it does not give the
agent hidden future events, scoring rules or colleague knowledge.

Stage 3 is complete only after the candidate and baseline run the matched fixtures
through the shared path, the boundary and finalisation checks pass, and a comparison
record shows latency and workflow/budget sensitivity. The decision must state which
policy becomes the default, why, and what remains unmeasured. Strong sensitivity to
reasonable charges is a result to disclose and resolve before interpreting timing
as model capability; code passing its tests is not duration validation.

Practitioner review is needed before describing the selected charges as realistic
accountancy work. A priced model pilot may follow deterministic acceptance; a paid
comparison matrix still requires approval. Case transition rules, competing reviewer
capacity and multi-day memory remain later roadmap milestones, rather than implied
features of this first timing experiment.
