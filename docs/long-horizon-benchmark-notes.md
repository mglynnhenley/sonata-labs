# Long-horizon benchmark research and design notes

Recorded 11 September 2026 from the product discussion. These are research findings and proposed design choices, not a record of implemented functionality. Delivery order and implementation status live in the [benchmark realism plan](benchmark-realism-plan.md).

Applied in the subsequent [plan review](benchmark-realism-plan.md#changes-from-the-benchmark-research-review): diagnostic pilots before comparative claims; report validation from the first milestone; explicit follow-up and memory tests; a timing-policy decision before long-horizon comparisons; and separate checks for data isolation and agent execution boundaries.

## Product intent

The initial audience is researchers comparing agents on realistic business work and its cost. Start with the accountancy adviser scenario: an institution supplies its intentionally categorised FATCA/CRS investor database; an AI assists human colleagues across several kinds of casework. Comparing years is one activity, not the whole premise. Human review and justified pending cases can be appropriate outcomes.

The report must explain what was expected, what the agent did, what happened next, the evidence and the resulting status. Distinguish agent mistakes, ordinary business delays and simulator failures. A long calendar duration alone is not evidence of a demanding benchmark.

## What other benchmarks do

| Benchmark | Time and state | Implication for Sonata |
| --- | --- | --- |
| Original Vending-Bench | Built using Inspect. Actions advance simulated time; `wait_for_next_day` advances to tomorrow. Morning notifications report purchases and new email. Limited conversation context is supplemented by memory tools. | Inspect can host a persistent business simulation; the benchmark supplies its time semantics. |
| Vending-Bench 2 | A simulated year with time-consuming sequential tool calls, overnight inbox refreshes, context trimming, notes and reminders. Delayed deliveries, negotiations and supplier failures affect later outcomes. Scores year-end bank balance. | Preserve delayed consequences and continuity. Its business objective and daily cadence are not automatically suitable for tax casework. |
| E-Commerce Bench | Tools consume simulated minutes from a 600-minute day; daily updates process when the clock passes 18:00. A deterministic negotiation kernel sets prices and decisions; an LLM renders dialogue. | Explicit budgets constrain work. Separate consequential business decisions from conversational wording. Daily batching may be too coarse for our meetings and intraday deadlines. |
| TheAgentCompany | Assigned workplace tasks involving applications, files and simulated colleagues, evaluated through task outcomes and progress checks. | A source of concrete workplace-task design; task length is different from simulating a continuing business calendar. |
| Original τ-bench | Multi-turn customer interaction and business API use; evaluates resulting database state against the task goal and reliability across trials. | Check actual work products, not merely persuasive dialogue. This is not a simulation of weeks of company operations. |
| METR time horizons | Task length is calibrated by human expert completion time; success probability is estimated against that length. | Do not equate simulated days or elapsed agent runtime with METR's human-task-duration measure. |

Primary sources consulted:

- [Original Vending-Bench paper, methodology](https://arxiv.org/html/2502.15840v1).
- [Andon: Vending-Bench 2](https://andonlabs.com/evals/vending-bench-2). Keep its documented behaviour separate from details specific to the original benchmark. Andon's [physical deployments](https://andonlabs.com/blog/evolution-of-bengt) involve real elapsed time and are separate from the simulation.
- [E-Commerce Bench design](https://ecbench.github.io/) and [paper](https://arxiv.org/html/2608.30730v1).
- [TheAgentCompany paper](https://arxiv.org/html/2412.14161v3). An [Inspect adaptation](https://ukgovernmentbeis.github.io/inspect_evals/evals/theagentcompany/) exists; its documented rollout is partial, not evidence of complete parity with the original benchmark.
- [Original τ-bench paper](https://arxiv.org/abs/2406.12045).
- [METR methodology and interpretation limits](https://metr.org/time-horizons/).

These are descriptions of published designs, not independent validation of realism. Deterministic state transitions do not eliminate variation from LLM dialogue or the tested agent.

## Proposed clock design

Use event-driven simulated time as a candidate, subject to comparison with our existing timing policies. Maintain one engine-owned queue for arrivals, work completions, deadlines and wake requests. Inspect runs the evaluation and agent; our engine controls business time and state. Advancing to the earliest scheduled event is an established [discrete-event simulation pattern](https://simpy.readthedocs.io/en/latest/topical_guides/time_and_scheduling.html), not a feature Inspect supplies automatically.

- Skip idle periods, including overnight, while processing intervening events and deadlines. Do not skip competing work merely because the agent is awaiting one particular reply.
- A genuine incoming notification may wake the agent. An unanswered request should not trigger a helpful reminder invented by the evaluator. Let the agent set reminders or perform its own follow-up; declare any default polling or wake schedule.
- Give active work a stated budget or duration policy. Unlimited activity within frozen business time makes deadlines meaningless. Arbitrary minutes per API call can favour particular tools or harnesses, so test sensitivity before choosing a default.
- Distinguish waiting, completion, budget exhaustion, cancellation and infrastructure failure. A model stopping tool calls does not necessarily mean the business episode has ended.
- Preserve app data, case state and commitments across days. Keep trusted world state separate from agent memory; do not provide a perfect daily recap or silently repair forgotten obligations.
- Keep real runtime and resource budgets separate. Compressing waits removes idle time, not the inference and tool execution needed for substantive work.

Example: Monday's evidence-request draft receives human review; the client responds Tuesday; Wednesday's correction requires revisiting the workbook and the handover. Other cases and meetings continue throughout. Whether the agent follows up, remembers scope and revises the correct deliverable is the test.

## Inspect benefits and limits

Use a thin integration with the existing engine, MCP tools and scoring. Inspect offers custom agent loops, state, compaction, evaluation logs, limits and sandbox integration. It does not supply realistic colleagues, business-time rules or a validated rubric. See [custom agents](https://inspect.aisi.org.uk/agent-custom.html), [limits](https://inspect.aisi.org.uk/setting-limits.html), [Agent Bridge](https://inspect.aisi.org.uk/agent-bridge.html) and [sandboxing](https://inspect.aisi.org.uk/sandboxing.html).

Record which calls actually pass through Inspect; arbitrary external model calls are not automatically captured or metered. Report agent, colleague/world and judge spending separately where available. Hold the harness and memory policy fixed for model comparisons, or label the comparison as one of complete agent systems.

At the time consulted, [Inspect checkpointing](https://inspect.aisi.org.uk/checkpointing.html) required the development version and explicit agent support. It captures registered agent state, configured sandbox files and sample store/events, not arbitrary running processes or external side effects. Coordinated restoration of our databases and event queue remains implementation work.

## Validation before claiming a long-horizon result

Start with one credible busy day, then a three-day continuation. Compare matched cases with different overlap and delay to distinguish coordination demands from simply adding more tasks. Keep ordinary settled work alongside difficult cases.

Test deadline boundaries, simultaneous events, lost or duplicate wakes, proactive follow-up, memory continuity and incomplete runs. Compare timing assumptions before replacing the scheduler. Separately test real-duration reliability if making claims about hours or days of continuous operation.

Every reported episode should identify simulated duration, substantive workload, real runtime, cost, memory policy, timing configuration and evidence gaps. Calendar planning, sustained decision-making and operational uptime are different measurements. No paid run or benchmark matrix was authorised merely by this note-taking request.
