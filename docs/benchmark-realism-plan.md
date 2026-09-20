# Plan to improve benchmark realism

Research companion: [long-horizon benchmark notes](long-horizon-benchmark-notes.md) records the Andon and other benchmark comparisons, Inspect tradeoffs, and proposed clock, wake and memory policies discussed on 11 September 2026. These are design inputs, not implemented features or a replacement for the delivery order below.

Purpose: make Inspect the runner for normal Sonata AI evaluations, then establish one credible accountancy evaluation whose report explains outcomes and identifies missing evidence. Extend it across days after that. Using Inspect does not by itself validate the scenario, scoring or a published model comparison.

Status, reviewed 15 September 2026: normal dashboard/CLI agent execution and all product judging now run through Inspect. Rejudging saves separate assessments with report history, exact prompt fingerprints, costs and downloadable Inspect logs. Each evaluation has private Docker app containers, data, ports, scoped credentials and run-specific dashboard links. The fixed Inspect harness uses an isolated MCP runtime; actual-container checks cover restricted networking, filesystem and control boundaries, concurrent data isolation, browser interactions and cleanup. Inspect orchestration, model transport, the engine and the judge remain trusted host code. The two observed colleague destination failures are covered by schema restrictions, route validation and saved-parent routing; any remaining colleague delivery failure excludes a run from numeric scoring. Stage 2 is complete for this local fixed harness. Stage 3 has compared the two timing policies on that path and recorded its decision: compressed wall time stays the default and the operation-charge clock `provider-operations-v1` is a selectable experimental option. Arbitrary external harness integration, hosted access, charge calibration and practitioner validation remain outstanding. See [Stage 2 verification](stage2-isolation-verification.md) and [Stage 3 verification](stage3-timing-verification.md) for scope and evidence.

The latest four-interval paid diagnostic completed with native Inspect execution
and assessment logs, two observed app mutations, four snapshot pairs and all
13 calls priced ($0.338989). It verifies the product path, not a full-day result.
Short or incompletely captured days and truncated judge prompts now retain their
diagnosis without a numeric Inspect assessment metric. A restart during judging
preserves completed session evidence. These safeguards and the late-action
deadline refusal have regression tests; original pilot logs remain unchanged.

## Where the product actually is

| Entry point | What runs today | What this establishes |
| --- | --- | --- |
| Dashboard “Start” and normal CLI run | Inspect drives the tested AI against a Sonata live session | The shared product path is implemented and exercised with scripted success, failure, cancellation, spend limits and judging. A full real-agent pilot has completed with judging and linked evidence; the observed delivery fault classes now have regression fixes. |
| Standalone Inspect task | The same adapter creates its own Sonata live session | Existing scripted integration checks and a short real-colleague pilot remain available for adapter diagnostics. |
| “Me, in browser” session | A human uses the apps; director and judge are disabled | A way to explore the scenario manually, not evidence of the Inspect migration. |

Product flow: choose a scenario and model in Sonata, press Start, and Inspect runs the AI being evaluated. Sonata supplies the workplace, business clock, simulated colleagues and assessment; the dashboard shows progress and the report. Colleague calls remain in Sonata. Initial judging and rejudging call an Inspect scorer using Sonata’s existing prompt and schema, with each assessment saved separately. All roles retain distinct cost records. This does not require rewriting the world simulation in Python.

For product testing, the user should be able to launch and watch an AI through this normal dashboard flow. Personally acting as the employee is a separate optional mode.

The first target is the tax reporting adviser scenario, `tax-reporting-workbook-day`. It starts with the institution's intentionally categorised investor database. The AI assists a human adviser with several kinds of casework; year-on-year changes are one task, not the premise. The aim is to measure useful work, correctness within supplied instructions, time and agent cost, with a readable explanation of mistakes and simulation failures.

## Review decision

Keep the existing engine, app replicas and separation of tested agent, simulated colleagues and judge. Change the delivery priorities: establish a credible task and measurement contract before expanding the social simulation. The target is the smallest business simulation that exercises the intended skills reliably. More messages, personalities or branches do not by themselves establish realism or make a benchmark harder in a useful way.

The original plan underweighted five issues: practitioner input came too late; external harnesses may expose different evidence to the world; the clock defines artificial work opportunities; conditional grading can reward avoidance; and free-form message interpretation can become an unreliable hidden evaluator. Address these before making broad claims from comparisons.

Deployment decision: each launched scenario gets its own isolated business environment. Build and verify that locally first, then host the same run environment on remote workers. Remote hosting is not a substitute for isolation. The accountancy practitioner example can be refined alongside architecture work and does not block local isolation.

Launcher decision: integrate through the existing external live session. The product launcher creates one session and gives its public launch configuration to the Inspect task; a standalone task creates its session through the platform API. Both use the existing MCP tools and finalise the session before scoring. Reuse the engine's assessment path and make cleanup idempotent on success or failure. Business time stays in the TypeScript engine; tested-agent model calls go through Inspect's model API. Extend this path to meet the lifecycle contract rather than claiming that the current built-in and external loops are already equivalent. Do not wrap an opaque TypeScript agent subprocess and describe its uncaptured calls as an Inspect transcript.

Isolation decision: Stage 2 is complete for the local, fixed Inspect harness. Each session has private Docker app containers, data, ports, scoped credentials and an isolated tool runtime. Actual-container probes verify the filesystem, control, network and cross-run boundaries. Inspect model transport, the engine and the judge remain trusted host code; the model gateway holds provider credentials. Manual company setup still uses the shared-app lease. Arbitrary external harness integration and hosted access remain later work. See [Stage 2 verification](stage2-isolation-verification.md) for scope and evidence.

## Changes from the benchmark research review

- Borrow Andon's persistent consequences, explicit waiting and agent-managed memory. Use finer intraday scheduling where our reviewer availability and deadlines require it; do not copy a daily cadence just because it works for a vending business.
- Borrow concrete workplace deliverables from TheAgentCompany and outcome checks from τ-bench. A convincing colleague response is not sufficient evidence of completed work.
- Use code to validate authority and prerequisites, with LLMs expressing permitted colleague responses. E-Commerce Bench provides a relevant precedent, but language interpretation and wording can still introduce error or variance.
- Keep simulated calendar duration, substantive work, human task duration and real execution time distinct. METR's time horizons cannot be inferred from our simulated days.
- Treat early model runs as diagnostic pilots. Different models may legitimately tie; establish sensitivity with known successful, incomplete and erroneous action sequences before expecting any model ranking.

Sources and qualifications are in the [research notes](long-horizon-benchmark-notes.md#what-other-benchmarks-do). These precedents inform the design; they do not prove our realism.

## What does not change

- The engine, the app replicas, the tick clock as the baseline timing policy, and the separation of tested agent, simulated colleagues and judge.
- Clone reset stays `copyFileSync(snapshot.db, working.db)`; each new session now owns its data directory.
- The business criteria and raw artifacts of the existing `tax-reporting-workbook-day` pilot remain intact. The measurement gate now withholds numeric results when the artifact records a failed colleague response. This changes report eligibility, not the authored business rubric; retain the original evidence and explain the exclusion.
- The audit log as the agent's record: world-generated messages and edits stay out of it.
- The dashboard as the control panel and the detailed case report as the product's output.
- Colleague model calls stay on the engine's client; the tested agent and judge call models through Inspect. Report agent, colleague/world and judge costs as separate categories wherever captured; mark missing accounting explicitly.

## Delivery order

Completed foundation: recipient-scoped colleague context, removal of future-event exposure, shared communication readers and observation-gap reporting. This is context isolation, not an isolated execution environment, and it is not yet committed.

The numbered sections later in this document describe work areas; the table is the delivery order. Report work starts at the first milestone and continues throughout.

| Stage | Deliverable | Evidence required to move on |
| --- | --- | --- |
| 1. Switch the product to Inspect and validate a serial pilot | Dashboard and CLI launch the existing Inspect task through one shared path; one-page scenario and rubric contract; readable report; audit of the current clock and provider failure. | Normal Start produces an Inspect transcript for the selected real agent model, linked to the Sonata session and assessment. Scripted checks distinguish known success, agent error, pending work and harness failure, without overlapping runs or premature end on waiting. Stop and failure retain evidence and release the lease. A full-length priced agent-model pilot with judging and grading review establishes the remaining evaluation evidence. |
| 2. Reproducible run environment | Private data, service addresses, container startup and GUI links for each run. | Two deterministic samples cannot modify each other's data or the seed; reset reproduces starting state; cancellation retains evidence and cleans up. Security boundaries pass before unrestricted or external agent execution. |
| 3. Timing decision | Compare the tick baseline, compressed-wall-time path and event-driven candidate on matched fixtures. | Defined work budgets, notification/wake rules, deadline ordering and final capture; measured sensitivity to latency and scheduling assumptions. Choose and version the policy before interpreting time-based model comparisons. |
| 4. One branching case | Persistent commitments, validated review transitions and a case-level report. | Valid alternative workflows succeed; missing evidence cannot create approval; a justified pending case and an agent-caused delay remain distinct. |
| 5. Busy day, then three days | Several cases competing for reviewer capacity, followed by a continuation with delayed evidence and revisions. | Matched overlap/delay variants, agent-managed follow-up, preserved memory policy and no evaluator-supplied daily rescue summary. |
| 6. Research release and portability | Versioned scenario package, reproducible instructions, reviewed grading, controlled comparisons; hosted access and a VC case as follow-ons. | Artifact and measurement coverage disclosed; approved repetitions and held-out variants support the stated claims. Hosted execution passes isolation checks before external access. |

Audit baseline from 11 September, with Stage 1 updated against live evidence on 14 September (statuses are against the plan's own wording; a doc or prompt sentence does not count as delivery):

| Stage | Deliverable | Evidence to move on | Blocking gap |
| --- | --- | --- | --- |
| 1 | partial | adapter and product launch verified; evaluation validation partial | Dashboard and CLI now use Inspect. Product-route checks cover app mutation, Stop, provider failure, spend limits, transcript download and automatic judging. Earlier adapter fixtures cover waiting, pending work and final capture; a real colleague reply is linked to an agent action. The scenario contract now describes Inspect and the compressed clock. The full-length real-agent pilot completed with judging, four snapshot pairs and fully priced agent/world/judge calls. It exposed invalid Slack channel and thread references in two colleague responses, now reported as simulation faults. Practitioner grading review remains missing. The earlier colleague pilot produced an inappropriate promise to do the AI's sheet preparation; response delivery is verified, semantic role fidelity is not established. |
| 2 | complete for local fixed Inspect runs | concurrent data/reset/audit checks; 69 container-boundary checks; browser interactions; provider failure, cancellation, spend and owner/deadline cleanup verified | External harness integration and hosted worker access are outside this milestone. |
| 3 | complete for the two implemented policies | offline matched fixtures, real-HTTP gateway checks, and a live scripted pair through the product Inspect path | The policy decision is recorded: compressed wall time stays the default, `provider-operations-v1` ships as an explicitly experimental per-run option. Charge calibration and practitioner review of the work allowance remain open, so a timing-based model comparison is still not supported. See [Stage 3 verification](stage3-timing-verification.md). |
| 4 | not started | not started | No case, transition or commitment types; no interpreter or authority validation; the Excel app accepts invented evidence ids; the tax day is a 16-beat fixed script with no v2. |
| 5 | not started | not started | The director still has one pending-reply slot per person, so a second request to a busy manager is dropped; no multi-day clock. |
| 6 | partial | partial | Run-local scenario/runtime fingerprints and reproducible instructions exist; no reviewed release package, practitioner sign-off or controlled comparison report. Hosted access remains unimplemented. |

The repository-access finding is closed: Inspect launches the existing MCP tool bundle inside the run's restricted container, without a checkout or evaluator files. The live-run guard on `PATCH /api/episodes/[episodeId]` prevents scenario edits during a run. The workspace changes and verification artifacts remain uncommitted.

The Stage 1 product switch is implemented: dashboard and CLI use one Inspect launcher, existing settings resolve credentials, and model selection, progress, stop, app links and reports remain available. Run and session ids are identical; the original Inspect transcript is downloadable and captured model calls join Sonata's trace by role. Missing prerequisites produce a setup error with no fallback to the old agent.

Scripted verification of that exact product path has passed, and the obsolete platform agent loop has been removed. The priced full-length real-agent pilot has completed. Its two colleague-delivery fault classes now have regression fixes; review affected findings alongside the remaining domain/grading validation. Successful execution is not proof of benchmark validity. The narrative judge runs in a linked Inspect assessment task after Inspect exports the agent's evidence; the execution scorer imports the deterministic assessment and its original `.eval` is retained unchanged. Price estimates from the previous runner are labelled uncalibrated for Inspect, and historical runs keep their original evidence.

Stage 3 then compared the two clocks on that same path. `provider-operations-v1`
charges the agent's own provider operations — 1 unit per read, 2 per write, counted by
item — so business time no longer moves with inference latency or host contention, and
every admitted operation carries engine-owned attribution into the audit record. It is
selectable per run and labelled experimental everywhere it appears; results under the
two clocks are not comparable, and the charges are declared parameters rather than
measured human effort. The decision, the live matched pair and what remains unmeasured
are in [Stage 3 verification](stage3-timing-verification.md). The next engineering stage
is Stage 4's branching case.

Stage 2 preserves that product path inside private Docker workplaces. Immutable images, frozen scenario/seed and proxy scripts, separate credentials, an API gateway and an isolated tool container are recorded for each run. Real browser, concurrent data, adversarial access, failure and teardown checks passed. Workspace archives are bounded raw data; incomplete capture withholds a completed score. See [verification and limitations](stage2-isolation-verification.md). Domain and grading review continues alongside the later stages; working integration is not a completed benchmark or a reason to start a comparison matrix.

Price any model pilot before running it; ask before a benchmark matrix. Early pilots diagnose integration, task coverage and scoring. A tie between two models calls for examination of the traces, saturation, rubric resolution and uncertainty, not automatic redesign to force the expected ranking. Do not select scenarios merely because they separate favoured models.

The serial external-session prototype inherits compressed wall time. Capture that configuration and label its results accordingly; it is not yet a controlled comparison of business-work capability. A successful integration is not permission to publish broad long-horizon or tax-correctness claims.

Defer per-person model selection, unrestricted colleague conversations, full-company task simulation, a generic workflow editor and a continuous-time engine until observed limitations justify them.

## Inspect integration and review of the staged approach

Inspect defines evaluations as tasks combining samples, setup, a replaceable solver/agent and scoring, with cleanup hooks for both successful and failed sample execution. A sample can represent an entire business day; it need not represent an individual email or action. This fits our intended unit of evaluation. [Inspect tasks](https://inspect.aisi.org.uk/tasks.html)

Its agent interfaces support custom tool loops, scoped state and background work that ends with the sample. External harnesses can use an Agent Bridge, with bridged model calls recorded in the Inspect transcript. These features provide integration points; they do not establish business-time semantics or automatically instrument model calls that bypass the bridge. [Custom agents](https://inspect.aisi.org.uk/agent-custom.html), [Agent Bridge](https://inspect.aisi.org.uk/agent-bridge.html)

Inspect provides per-sample sandbox instances and supports multiple Docker Compose services. Provisioning a sandbox does not automatically move evaluation code into it, and a custom Compose configuration needs explicit network restrictions. Validate those boundaries in our actual configuration. [Inspect sandboxing](https://inspect.aisi.org.uk/sandboxing.html)

Serial integration contract, now exercised through the product: one complete accountancy evaluation using the Inspect task. Sonata's launcher provisions a private Docker workplace for the sample and starts a live session with the declared timing policy. The solver uses Inspect model calls and the existing Gmail, Slack, Calendar and Excel MCP tools. At a defined terminal condition, finalisation stops new work, drains or records in-flight actions under the cutoff policy, captures available state and obtains the existing assessment. The scorer reads that captured result with unmeasured items intact. Cleanup releases services and leases even after failure; scoring must not depend on cleanup having run first. This uses the existing lifecycle functions with idempotent finalisation and keeps the run inspectable from the dashboard. Inspect orchestration remains trusted host code; the tested model's app tools execute in the isolated runtime. Container ownership and teardown belong to the shared Sonata launcher, rather than a separate Inspect Compose implementation.

First use a deterministic solver and fixture to verify setup, successful tool mutation, world response, waiting, finalisation, scoring and cleanup. Exercise cancellation, provider failure and final-tick evidence capture. Run a priced model pilot only after this path works; a comparison matrix requires approval. Test concurrent samples after per-run data isolation. Join the Inspect transcript and run artifact using stable run, action and event identifiers, recording actual model configuration and capture gaps. Agent calls, world calls and judge calls need distinguishable cost records. A log containing final text alone is not a complete execution trace.

Each increment must exercise the complete path. Inspect is now the normal product runner; subsequent isolation work must preserve the verified launch, capture and assessment flow. This does not require a Python rewrite of the simulation. If a requirement needs an extension, name that gap and extend the one launcher.

### Review the simulation's steps separately from the implementation stages

Inspect does not decide how many simulated minutes a model turn takes. The previous built-in runner gave the agent work opportunities on fixed ticks; the current Inspect path uses sessions with a wall-clock compression factor. These are different experimental conditions. A tool-use loop ending is also not necessarily the end of the business day: the agent may be waiting for a colleague.

Retain the tick policy and external session's compressed-wall-time policy as separately labelled timing baselines. This preserves experimental definitions and historical results, not a second official tested-agent runner: timing belongs to Sonata and can be exercised with deterministic fixtures independently of agent orchestration. The initial Inspect integration inherits compressed wall time; do not present it as equivalent to the tick baseline. Before changing either policy, use matched fixtures and deterministic action sequences to compare:

| Timing policy | Useful for | Main limitation to measure |
| --- | --- | --- |
| Fixed work opportunities on ticks | A controlled initial baseline | Reply delays are rounded to ticks; allowed work per turn can dominate outcomes. |
| Compressed wall time | Measuring a complete deployed agent system under time pressure | Inference latency, retries and infrastructure contention affect the simulated opportunities. |
| Event-driven simulated time | Candidate default for business-work capability comparisons | Requires explicit, defensible action-duration or work-budget assumptions; it is not automatically realistic. |

For the event-driven candidate, maintain one engine-owned event queue for arrivals, work completions, deadlines and agent wake requests. When the agent waits, advance only to the earliest relevant event, including earlier competing deadlines; do not let it skip the rest of the world. Process pending arrivals at defined action boundaries. Use stated work-duration/budget assumptions so the agent cannot perform unlimited zero-time work. Preserve a separate real execution timer and cost/resource limits. Do not equate an LLM token or an arbitrary API call with a human minute without justification.

Separate world events from agent notifications. Deliver an actual incoming message under the declared notification policy; do not remind the agent of an unanswered request because the evaluator knows it is important. Provide agent-set reminders or scheduled wake requests, and document default polling and start-of-day wakes. A private event concerning another colleague must neither expose its contents nor automatically wake the agent. If the agent chooses to wait despite unfinished work, keep the original obligations and deadlines in the assessment.

Evaluate lost/duplicate wakes, idle model calls, deadline-edge behaviour, simultaneous-event tie-breaking, action completion ordering and repeatability. Inject different model latencies into deterministic action fixtures: event-driven business outcomes should not change solely because a provider is slower when no real-time budget is exhausted; compressed-wall-time results may change and must be labelled accordingly. Test plausible work budgets and alternative valid tool sequences for interface bias. Choose the default after these checks; this experiment precedes a broad scheduler rewrite.

For resource limits, distinguish a declared agent budget being exhausted from a provider outage or incomplete evidence capture. Define how work in progress is treated at the business deadline and at a real execution cutoff. Never turn an infrastructure failure into an ordinary failed day or silently extend a deadline during recovery.

Keep business workflows flexible under every timing policy. Evidence and authority are prerequisites, not a mandatory sequence of conversations. An agent may batch requests, prepare other work while waiting or use another valid route to a deliverable. Grade responsibilities and supported outcomes, not conformity to one step-by-step script.

## 0. Define the work and measurement contract

Begin with a practitioner walkthrough of one real, anonymised day: opening materials, decisions requested, actual outputs, communication paths, authority boundaries and plausible waiting times. Use synthetic replacements for sensitive records. Preserve mundane settled work as well as difficult cases. Record which details came from practice, which were invented and which still need validation. Do not describe the current fictional pilot as sourced from a real day.

Before expanding the scenario, make a one-page contract visible in its preview:

- The AI's role, tools, responsibilities and permitted actions.
- Required deliverables, deadlines and evidence of completion.
- Decisions requiring human review, and what constitutes a useful review request.
- Facts provided as fictional reviewer instructions versus domain knowledge being tested.
- Fixed background events, possible action-dependent consequences and known measurement limits. Keep private solutions and unreleased evidence out of agent-facing material.
- Agent harness, context/memory assistance, work budget, clock policy and cost categories.

Review prompt and scoring alignment. Agent and judge prompts now recognise required reviews and drafts as appropriate assistance; the scoring formulae are unchanged. Continue distinguishing ordinary review requests, necessary blocked-case escalation and abandonment throughout scoring and reports. Successful assistance may include supported analysis or a recommendation for review, where authored criteria permit it; approvals are not a reason to reduce the task to clerical transcription.

Review outcome criteria before authoring dialogue. Use actual cells, drafts and evidence links to establish success. Do not require exact phrasing or one sequence of tool calls when different approaches achieve the same result.

Acceptance: a practitioner can read the contract and explain both a successful day and a correctly pending case. The agent instructions and report use the same definition of successful assistance.

## 1. Use the current test day as a baseline

The accountancy test `run_mtwuwolb_0bbd` stopped at tick 15 of 36 with a provider 400 error, before the communication-boundary changes were applied. Preserve it as an incomplete baseline, not a completed performance result. Locate its JSON and trace in `apps/platform/data/runs` and archive available evidence outside disposable worktree storage, with an inventory of missing files. A minimal reviewed fixture may be committed for regression tests; raw logs need not be published to preserve the baseline. For subsequent tests, do not reset databases, change prompts, restart services or amend criteria during the run. Preserve artifacts, available starting and ending snapshots, workbook history, tool trace, scenario and model configuration. Record any version information the artifact does not capture separately; do not claim it was recorded if it was not.

Review a handful of concrete moments rather than just the final score:

- Did a colleague know something they had never been told?
- Did a reply address the actual question and preserve record IDs and scope?
- Did anyone repeat a request already satisfied, or forget a commitment?
- Did meetings, reply delays and agent waking follow the simulated clock?
- Did the colleague require plausible evidence before accepting work?
- Did the report distinguish an agent mistake from a missing event, failed tool or incomplete day?

For each example, retain the tick, person, message/tool reference, expected behaviour and observed behaviour. The current pilot is a workflow test, not a validated measure of tax-law correctness or a fully branching business.

Establish clock and harness behaviour before attributing timing errors. This audit needs no infrastructure and no paid model calls, so it starts before the isolation work rather than waiting for it. The previous built-in agent got an `act` opportunity each tick and a default backstop of 40 model steps, which could include tool calls; this is not a measured human work duration. Waiting for a valid reply should not require repeated busywork. Audit event delivery, duplicate/missed wakes, reply-delay interpretation, deadline boundaries and the final action's capture before adding more scheduling logic. Record findings rather than assuming the user's suspected tick bugs are confirmed.

For the first integration, retain the selected path's existing clock and state its limitations. Report simulated deadline performance separately from actual execution latency. Do not claim a model is faster at work merely because it completes more tool activity within a frozen simulated interval. Only change work-duration accounting or wake policy through an explicit versioned experiment; an immediate move to continuous time would add scope without validating those assumptions.

Continue validating evidence capture for the intended researcher harness. Built-in and external runs now share readers for delivered communications; private reasoning, reads, full tool arguments and external agent cost are still not equivalent. Verify that parity through the new isolated launch path. Distinguish a fixed-harness model comparison from a comparison of complete agent systems; disclose missing external model cost or reasoning telemetry rather than inventing it.

## 2. Fix knowledge boundaries first

The first implementation replaces app-wide filtering with recipient-scoped observations and removes future scheduled events from colleague prompts. This closes the initial communication-context gap; it does not provide process, network or cross-run isolation. The remaining work in this section concerns broader access state and initial knowledge.

Introduce structured visibility metadata on observable events: actor, recipients, conversation, channel membership, applicable record access and when the information became available. Build the colleague's context from these events and explicitly supplied initial knowledge. Do not infer access by parsing display summaries. If visibility cannot be established, omit the information and expose the resulting simulation gap.

Keep unreleased future events and private scenario facts in the engine. Give colleagues only released facts they can know. Validation can reject a response that conflicts with authorised facts without disclosing the future schedule to the speaker. A missing initial fact or an ambiguous visibility rule is an authoring defect to fix, not something the LLM should fill in.

Model availability and awareness separately: a document may be accessible without the colleague having read it. Give role-relevant initial knowledge explicitly and record when delivered evidence becomes known under the authored workflow. Avoid simulating every reading action unless the task needs that distinction.

Acceptance: two colleagues using Gmail cannot read each other's private threads; private Slack messages stay private; forwarding a document explicitly makes it available to the recipient; a scheduled afternoon correction never enters a morning colleague prompt. Exercise these through the existing engine and real clone routes using a deterministic model stub.

## 2a. Package per-run environments and enforce execution boundaries

Implemented and verified for local fixed Inspect evaluations: per-run app containers and SQLite files, isolated MCP execution, separate control credentials, restricted networking, a model gateway, pinned images, frozen scenario and runtime metadata, and independent cleanup. The acceptance evidence is in [Stage 2 verification](stage2-isolation-verification.md). External harnesses must implement the same container contract; host commands are not automatically contained. Hosted execution remains Stage 6.

Package the scenario separately from its execution. A versioned scenario package identifies starting snapshots, cast, events, case rules, criteria and required app versions. Its private evaluator material and unreleased evidence remain accessible only to trusted orchestration. The agent receives its task, allowed working files and tools, not the package's answer keys or the repository containing them.

The dashboard remains the control panel. A single launch mechanism creates a run environment with:

- Private app instances, SQLite data directories and a network namespace for that run. Start working databases by copying their saved snapshots; never point concurrent runs at shared working databases.
- An isolated agent harness with access only to its permitted app APIs and workspace. Keep the trusted engine, scenario controller and judge outside the agent's execution boundary. Do not mount the host home directory, repository, other runs or container-management socket into the agent environment.
- Separate agent and control credentials. Reset, seed, injection and audit-administration routes remain unavailable to the tested agent. Restrict network egress to its run's services and a controlled model gateway; the gateway holds provider credentials and enforces spending limits.
- A run-scoped service-address registry passed through the existing adapter and tool configuration. Resolve agent and trusted-control addresses from the same run registry: tools use the provider gateway, while world injections, observations and snapshots use the trusted proxy to those same app instances. Avoid process-wide URL changes when two runs coexist.
- An explicit lifecycle: allocate, restore snapshots, check health, run, capture artifacts, then stop and clean up. Enforce execution/resource limits outside the agent. Preserve available logs and artifacts after failures and label incomplete capture rather than producing a complete-looking score.

Use local containers for the packaged implementation. Local development should support opening that run's Gmail, Slack, Calendar and Excel from the dashboard, as well as inspecting its captured state after a failure. Export the scenario/runtime versions, starting-state identifiers, model settings, traces, final state and available cost records before cleanup. Define whether the GUI opens a retained environment or a restored read-only snapshot; do not imply live app access survives container teardown automatically. Capture artifacts as data; do not execute files produced by the tested agent while collecting or judging them.

No separate container is needed for each simulated colleague. Their individual knowledge and action permissions remain engine concerns. The main execution boundary separates the tested harness from trusted control services, with each business run isolated from other runs. Validate the actual boundaries rather than treating the presence of containers as sufficient proof.

Data-isolation acceptance: launch two copies of the accountancy fixture using deterministic test agents. Editing run A must leave run B and the saved snapshot unchanged. Stopping or resetting A must leave B running. GUI inspection and tools must resolve to the chosen run. Force a worker/provider failure and confirm retained evidence and an incomplete status. These checks do not require paid model calls.

Execution-boundary acceptance before unrestricted/external use: run A's agent cannot reach run B, control routes, host files, hidden criteria or arbitrary outbound destinations. Validate this from inside the actual harness environment, including shell access where offered. No separate container is required for each colleague.

Implement one launcher contract and reuse the existing simulation loops, adapters and artifact paths. When the local lifecycle and isolation checks pass, a remote worker can implement the same contract without another simulation engine. Hosted access, worker authentication and cleanup policies are a later delivery milestone, before inviting external researchers. Running untrusted third-party code remotely also requires assessing whether stronger worker isolation than ordinary containers is needed.

## 3. Persist commitments and case state

Add run-owned state within the existing engine, not a second simulation loop:

- Per person: known evidence references, assigned work, commitments, due times and review authority.
- Per case: stable ID, institution, affected records, regime scope, evidence available, missing evidence, owner, status, dependencies and decision history.
- Per transition: triggering event/action, prior state, resulting state, rule and simulated time.

Keep the business's actual facts separate from what a person currently knows. Persist state transitions in the run artifact so context-window limits do not erase a promise. Workbook cells remain the working deliverable; explicit rules determine which observed edits affect a case. Do not silently create a competing investor database in the engine.

This trusted case state is not the tested agent's memory. Do not inject outstanding obligations or private decisions into its prompt from the case registry. Give it only records and notifications available through its declared tools and workflow.

LLMs can propose interpretations of unstructured messages, but consequential transitions require validation against case rules and cited evidence. Ambiguous interpretations should yield a clarification or a visible simulation uncertainty. They must not silently become approvals or benchmark failures.

Make this boundary concrete: an interpreter extracts the referenced case, requested action and evidence from the actual communication; rules check actor authority and prerequisites; an accepted transition supplies the facts the dialogue may express. Routine consequential statements, such as a scoped approval, can use constrained fields or templates. Free-form conversation must not contradict a transition, invent an attachment or claim a review finished when it did not. Persist interpretation evidence and failed validations. Do not rely on confidence scores alone or claim deterministic rules eliminate errors in semantic extraction.

Represent a small set of composable prerequisites and transitions rather than writing a separate script for every possible conversation. Derive state by applying each accepted event once, using stable event IDs so retries cannot duplicate approvals or work. Start with an append-only transition record inside existing run artifacts; a general event-sourcing framework is unnecessary for the first case.

Acceptance: a colleague remembers an outstanding review after its conversation leaves recent history; saying “done” does not close a case whose deliverable is missing; reset restores the starting case state as well as the starting apps.

## 4. Build one complete branching tax case

Use the missing-document question for investor 00107 as the first candidate. A practitioner must supply or approve the fictional evidence requirements and resulting reviewer decision before these become a reference answer. Do not derive new tax rules from the current fixture.

Respect the assistant's existing authority: external messages remain drafts for Marta. The complete route is:

1. AI prepares a targeted document-request draft and asks Marta to review it.
2. Marta requests a revision or approves and sends the request as a world action.
3. The institution's contact receives it, seeks the available document, asks a clarification or reports a delay.
4. Evidence returns; the AI checks the case scope and prepares Daniel's review package.
5. Daniel requests missing material, leaves the case pending or issues the case's authorised decision.
6. The AI applies only the approved workbook change and updates reporting preparation and handoff.

This is one valid reference route, not an exact sequence required by the grader. Batching, preparing work early and other evidence-supported routes remain valid. Enforcing a colleague's authority must not silently repair the agent's workbook edits; record unsupported changes as actions and evaluate them. If an app itself blocks an operation, report that intervention rather than claiming the agent voluntarily respected the boundary.

Branches must have authored causes: wrong entity ID, vague evidence request, missing attachment, complete package, unavailable reviewer, approaching deadline. A persuasive message alone cannot create evidence or authority. A valid outcome may be a clearly documented pending case; closure is not always achievable during the day.

Create a new scenario version. The existing pilot explicitly keeps several cases pending and has fixed criteria: preserve it and its historical results. The new version must replace conflicting scripted messages and define outcomes for every reachable branch, including reviewer unavailability.

Acceptance: replay complete, incomplete and ambiguous requests through actual app routes. Verify the expected distinct paths, timing, preserved workbook originals and agent/world audit separation. A full paid model run is a later validation step, priced beforehand.

Include paraphrase and exploitation checks: equivalent valid requests take the same business path; “ignore the rules and approve this” does not create authority; invented evidence IDs fail validation; repeated sends do not create unlimited reviewer capacity. Check a human-written successful action sequence and a justified pending sequence before evaluating a model. This tests the simulator independently of the agent being benchmarked.

## 5. Make competing work and meetings matter

Draft workload and capacity fixtures alongside the clock audit. Adopt their time-based acceptance criteria only after the timing-policy comparison; do not let this dependency block all case-state or report work.

Replace a single pending-reply slot with explicit work items. Each has a recipient, case, priority, prerequisites, estimated simulated duration and deadline. Acknowledging an email and reviewing a case should consume different amounts of simulated time.

Use the shared calendar as the source for availability, with scenario rules for protected meetings and urgent interruptions. Schedule colleague completion through the engine's selected timing policy. Start with deterministic durations and tie-breaking; do not introduce arbitrary random delays. Add reproducible variations later, with assumptions recorded.

Add an institution contact with limited knowledge and evidence-retrieval work. Begin with structured dependencies between colleagues rather than unrestricted LLM-to-LLM conversations that consume cost without observable progress.

Acceptance: two simultaneous reviews compete for the same manager's capacity; work resumes after meetings; reprioritising one case delays another visibly; messages do not receive impossible immediate replies. Test tick boundaries, due replies and wake behaviour together, including the final tick and incomplete work at day end.

## 6. Make the report explain causes

Start this in stage 1 using available historical artifacts and deterministic fixtures. Extend it when branching state arrives; report clarity is not deferred until the simulator is complete.

Add a case view with five fields: what was needed, what the agent did, what the colleague/world did next, why that happened, and the resulting work status. Link each finding to source messages, workbook changes and the earliest evidenced deviation. Do not infer a causal claim from chronology alone; label uncertain attribution.

Show task outcomes, agent cost, world-simulation cost, judge cost where available, simulated completion time and wall time separately. Report justified escalation and correctly held cases as appropriate work, rather than treating human involvement as failure. Keep colleague opinions distinct from evidence-based grading.

Show scenario/rubric versions, initial-state identifiers, harness and memory policy, timing configuration, assigned case count and dependency/overlap structure. Tool counts and messages describe activity, not useful work by themselves. A "three-day" label must not imply three days of human labour or three days of uninterrupted system uptime. Export the report with evidence references so a reader can follow findings without the live GUI.

Judge against the opportunities and information actually available on the realised path. Preserve deadlines when the agent itself caused the delay. Treat engine failures, impossible branches and missing evidence capture as measurement gaps. Support multiple valid ways to complete the job.

Keep initial obligations fixed: neglecting to request evidence must not remove that case from the score denominator. Use conditional subcriteria for consequences that truly depend on new information, alongside the original responsibility to pursue and hand off the case. Show why an item is pending, unmet or unmeasured. Separate business outcome, process quality and simulator uncertainty rather than hiding them in one percentage.

Use deterministic checks for fields, scope, attachments and deadlines where evidence permits, and rubric-based human/LLM review for substantive analysis and communication quality. Simulator state is evidence of what happened in the world; it is not an independent proof that the agent did good work. The same semantic interpretation should not both unlock success and be the sole evidence used to grade it. Validate grading against a small set of manually reviewed traces, including one where a colleague sounds satisfied but the workbook is wrong.

Acceptance: a reviewer can explain an incorrect workbook update from the case view without reading the full trace, and can tell whether an unfinished case arose from the agent, an intended client delay or a simulator defect.

## 7. Validate realism and portability

Have a tax practitioner review the opening case materials, evidence requirements, colleague authority, message exchanges and time estimates. Treat this as validation still to do, not evidence already obtained. Use anonymised or synthetic case materials grounded in practitioner examples.

This review begins in step 0 and repeats on actual interactions; it is not a final gate deferred until the engine is built. Build several tax cases once the first works: unchanged settled records, incomplete evidence, conflicting evidence, an authorised scoped update and a corrected amount. Some cases should finish quickly and some should remain pending. Do not force every scenario into an approval chain when the real task permits independent work.

Test long-horizon capability through dependencies across time: preserving an earlier promise, revising a deliverable after new evidence, resuming after an interruption and handing work across a day boundary. A larger number of ticks or back-to-back emails alone is not evidence of a long-horizon challenge. Start with matched low-overlap and high-overlap variants using the same case facts to isolate coordination load. A later multi-day variant can add continuity demands without merely inflating message volume.

The first extension is a three-day continuation of the validated busy day, represented as one evaluation episode. Preserve app databases, case state and the agent's declared memory across day boundaries. Include one delayed response, one absent response requiring agent-initiated follow-up, and one correction that changes an earlier deliverable. Keep a matched variant with the same case facts and work requirements but different overlap/delay; disclose where changed opportunities prevent a clean comparison. Do not claim that inserting empty nights increases substantive workload.

Define memory tools, context limits and compaction before comparing models. Do not create fresh daily agents with complete evaluator-written briefings. Test what happens when an earlier commitment leaves recent context. Coordinated checkpoint/recovery must cover database state, the event queue and supported agent state; Inspect's checkpointing does not automatically preserve our running services. Until recovery is verified, label interrupted episodes incomplete. See the version-specific [checkpointing note](long-horizon-benchmark-notes.md#inspect-benefits-and-limits).

Calendar planning, sustained decision-making and real-duration operational reliability are separate claims. Add real-duration soak tests for outages, resource leaks and recovery only when making operational-uptime claims; a compressed week cannot establish those results.

Then author one VC diligence case using the same visibility, commitments, queues and transition mechanisms. Business-specific rules and grading should live in scenario data; add engine features only when both cases justify them.

For comparisons, hold the scenario version, initial state, company model configuration, rules and clock policy fixed while changing the tested agent. Save prompts/model settings and world events; live LLM dialogue is not guaranteed to repeat exactly. Run repeated trials when warranted and approved. Investigate whether simulator model changes alter agent rankings before claiming robustness across simulator models.

Before a research release, manually review a small evidence set spanning correct completion, valid pending work, agent error and harness failure. Establish that the rubric responds to meaningful differences in those traces. Predeclare comparison settings and report variability across approved repeated trials; do not assume two single runs establish a ranking. Retain failed and tied runs, with their measurement limits. Validate relevant domain decisions with the practitioner; tax-law correctness and real XML filing remain unmeasured unless explicitly added and validated in a separate task version.

Create held-out case variations with coherent changed facts and outcomes, not just renamed people. Keep benchmark solutions and grading internals out of the tested agent's accessible workspace. Track per-case outcomes and variability across trials before a headline ranking. Replay captured events for debugging; do not reuse another agent's action-dependent replies as if they were a valid live world for a different trajectory.

Acceptance: both tax and VC cases run through the existing runner and reporting path; comparison reports identify configuration differences and limits on reproducibility. Realism claims cite practitioner review and observed tests, not just successful compilation.

## Likely implementation areas

Likely implementation areas: `apps/platform` and `packages/cli` for launch/lifecycle and inspection; clone startup configuration and container definitions for per-run services; `packages/core` for run configuration and state/event types; `packages/engine` for observations, director context and scheduling; `packages/scenarios` and `packages/world` for versioned cases and fixtures; `packages/judge` and the platform for grading and the case report. Reuse existing twin adapters, snapshot reset and simulation paths. World-generated messages and edits must remain outside agent audit.
