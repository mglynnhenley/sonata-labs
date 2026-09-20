# Are these business weeks complex enough?

Historical research and design review of the twelve original [archived business specifications](../scenario-archive/README.md). The dependency and grading lessons remain useful; this is not the active selection list or a measurement of model difficulty. The [UK critical-infrastructure research](critical-infrastructure-research.md) and [scope decision](critical-infrastructure-scope.md) now govern admission and pilot order.

**Judgement: a credible foundation for a pilot, with substantial differences in how strongly the cases interact. They are not yet demonstrated to be difficult, representative full working weeks, or reliable predictors of deployment safety.** The strongest feature is that obligations survive changing evidence. The main weaknesses are light workload calibration, overly helpful presentation, and several case collections that could be solved independently.

The rubrics and targeted additions address authoring gaps. Human reference work and model pilots will still be needed to establish actual difficulty. A model performing well is a result, not a reason to keep changing the test until it fails.

## What the online research changes

The following are primary sources reviewed for design lessons. Reported scores from other benchmarks are not forecasts of performance on ours. This is a focused comparison, not an exhaustive novelty search.

| Source | Relevant finding or design | Implication for this suite — our inference |
| --- | --- | --- |
| [Andon Labs, Vending-Bench 2](https://andonlabs.com/evals/vending-bench-2) | Runs a vending business over a simulated year and uses final bank balance as its headline score. | A five-day calendar is not our novelty. Emphasise responsibility across different operational roles, with completion, boundary failures and owner visibility measured separately. |
| [Andon Labs, Vending-Bench Arena](https://andonlabs.com/evals/vending-bench-arena) | Places competing vending agents in the same location, allowing trade and communication with individual scoring. | Keep models facing the same business assignment independently. Cross-model competition would answer a different question. |
| [WorkArena++](https://arxiv.org/html/2407.05291v1), §§3.1–3.3 | Composes simpler tasks; distinguishes explicit step instructions from goals requiring retrieval and planning; includes validation and solution oracles. | The agent should infer a plan from available business records. Keep future events and the grading checklist out of its briefing; require source joins and real dependencies. |
| [TheAgentCompany](https://arxiv.org/html/2412.14161v1), §§2–4 | Uses a simulated workplace, colleague interaction, and both full and partial checkpoint scoring. | Workplace simulations and partial rubrics already exist. Our proposed contribution is following continuing responsibilities through a whole changing portfolio and inspecting the owner's supervision burden. |
| [τ-bench](https://arxiv.org/html/2406.12045v1), §3 | Uses policy-constrained tool interactions, database outcomes and repeated-trial reliability; notes that outcome success need not establish every policy requirement. | Judge intermediate commitments as well as Friday state, preserve repeated runs, and avoid treating final success as sufficient safety evidence. |
| [METR, task-completion time horizons](https://metr.org/time-horizons/) | Defines task length through human expert completion time, distinct from agent runtime. | Measure human active effort separately from five simulated days, waiting, tool calls and model runtime. These weeks cannot establish a METR-style one-week horizon. |
| [AgencyBench](https://arxiv.org/html/2601.11044v1), §3.3 | Specifies deliverables and rubric-based assessment, and compares automated judgements with human annotations. | A rubric needs concrete evidence and calibration; attaching a numerical scale does not make a judge reliable. |
| [AgentDojo](https://arxiv.org/abs/2406.13352) | Evaluates agents using untrusted tool data under prompt-injection attacks, alongside ordinary task performance. | Ordinary operational mistakes and adversarial compromise are different conditions. Our current primary suite does not establish prompt-injection robustness. |
| [Assis and M, industrial honeypot](https://www.lesswrong.com/posts/zLpAcx2m6j8CGvRsy/the-case-for-industrial-evals) | Steel-plant inbox with explicit fraud requests; most models refuse, a safety goal drives compliance to near zero, and Claude 4.5 verbalises evaluation awareness depending on tag names and tool format. | Explicit requests are controls, not the measurement. Fix and report goal framing, tag names and tool format; measure verbalised awareness; concentrate exposures where nobody asks. See [honeypot lessons](honeypot-lessons.md). |

## Where the current drafts are strong

Several weeks contain decisions with consequences in another case: freight's shared vehicle, staffing's shared roster, procurement's adapter/artwork and budget dependency, and tax's three review slots. SaaS has a shared Thursday engineering reservation that enables both accounts' tests; this is a common prerequisite, not competing eligible bookings. After the revisions below, IT's single Thursday engineer slot and property's binding reserve join them. These are useful tests of planning because a locally reasonable choice can change what remains possible elsewhere.

Every week also requires an earlier interpretation to change: tax ownership evidence, a corrected claims estimate, revised delivery evidence, or new incident findings. This permits a meaningful distinction between a justified earlier action and a later failure to revise it. Cases with pending payments, residual sessions and queued demands provide evidence beyond an agent's written assurances.

The specifications include permitted recovery routes and unresolved Friday liabilities. That supports testing useful delegation rather than forcing every case into either refusal or unsupported completion. Their strongest research question is whether an agent maintains the correct state of its responsibilities while continuing other work.

## What is still too easy or too artificial

**Calendar padding.** Several portfolios contain only three or four difficult cases plus a small routine queue. There is no measured human workload, minimum action trace or demonstrated sustained attention demand. Those cases may still be hard, but the calendar alone cannot establish that. Calling this a simulated operating week is justified; claiming forty-five hours of human work is not.

**A timetable can become an answer key.** The daily tables currently name exact corrections, required next actions and future failures. They are excellent authoring documents but would make poor agent briefings. The visible assignment should give responsibilities and company policy. Details arrive through actual sources, and the agent must find which records and promises are affected.

**Shared people are not always real resource constraints.** Saying four cases compete for a supervisor is insufficient unless the schedule or decision capacity forces a choice. Some review windows can accommodate everything. Make consequential capacity explicit where it matters, while ensuring a competent operator can complete the required work or choose a published acceptable tradeoff.

**Too much prompting can remove ownership.** If every missed action produces a reminder naming the solution, the counterpart is performing the monitoring. Include at least one discoverable obligation per week that must be remembered or found through a normal queue inspection. Do not secretly remove reminders a real operator would have received.

**Repeated patterns can turn into a template test.** Many weeks feature a Wednesday correction, a Thursday timeout and a Friday handover. Those are individually reasonable, but twelve reskinned copies would exaggerate breadth. Keep domain-specific reasoning central: compatible launch quantities, accepted staffing coverage, retained tax evidence, or a valid evaluation denominator. Vary realistic failure mechanisms during authoring, then freeze the same chosen week across models.

Water reporting and government casework still share a revised-source → stale-notice → continuing-handoff sequence. Treat that as correlated mechanism coverage, even though water adds provisional scientific reporting and government adds original request receipts, person/period evidence and scoped decisions. Report domain-specific outcomes separately and do not count sector names as independent failure mechanisms. A second independently authored week would be needed to establish broader coverage; arbitrary extra incidents would not establish it.

**Authority compliance is only part of business judgement.** Always escalating is easy. Include decisions within standing authority where the agent must select between useful alternatives, explain the tradeoff and act. Several alternatives should be acceptable when policy and customer preferences permit; do not require the evaluator's preferred email order.

**Safety exposure is intentionally selected.** These weeks concentrate consequential situations. They can show what happened under those conditions, but do not estimate the frequency of those conditions in ordinary customer workloads. More failures in one authored week do not establish that its industry is inherently riskier.

## Review of each business

These are qualitative authoring judgements based on the original drafts and the specified additions, not numerical difficulty ratings.

| Business | Existing source of complexity | Weakness to address | Targeted strengthening in the revised specification |
| --- | --- | --- | --- |
| [Tax](../scenario-archive/commercial/tax-reporting.md) | Scoped decisions propagate through workbook records and totals; limited technical reviews. | Following an explicit change list could bypass tracking downstream reliance. | Make a preview/version dependency require replacing stale downstream material, retaining the existing adviser-assistance premise. |
| [Freight](../scenario-archive/commercial/freight-brokerage.md) | Two loads share capacity; changed appointments affect terms and recovery. | A carrier can otherwise look like a simple price-and-time choice. | Require retrieval and reconciliation of a nonlocal commitment/term before confirming the linked movement. |
| [Staffing](../scenario-archive/commercial/staffing.md) | Qualifications, worker acceptance and overlapping client schedules interact. | Availability and acceptance may be treated as static flags. | Require a separate named-worker rehearsal briefing after reassignment, with actual lost coverage if missed. |
| [Procurement](../scenario-archive/commercial/procurement.md) | Budget, part selection, artwork and actual received quantities jointly determine launch readiness. | Goods arriving can be mistaken for usable goods without a receiving dependency. | Tie packaging delivery to a reserved dock slot and replacement spend to acknowledged cancellation. |
| [Managed IT](../scenario-archive/commercial/managed-it.md) | Cross-application access and shared engineer windows create long-lived consequences. | Successful migration can be treated as a terminal state; the claimed engineer contention did not force a choice. | Require a later rollback-retention decision based on actual verification; make Thursday's single Omar slot serve either Beacon or Cedar, not both. |
| [Research/evaluation](../scenario-archive/commercial/research-evaluation.md) | Protocol, exclusions, limited reruns and independent review constrain the report. | Most numerical work is small and could become a simple denominator exercise. | Make a later substantive revision affect review scope and release authority. |
| [Property](../scenario-archive/commercial/property-management.md) | Staged repairs, separate owner funds, access and closeout evidence interact. | Booking a contractor may appear to finish access coordination; the reserve never bound. | Tie rented equipment collection to verified repair, with an approved extension when it must remain; lower Birch's reserve so the late branch forces a deferral. |
| [SaaS](../scenario-archive/commercial/saas-operations.md) | Incident evidence affects renewal, onboarding and billing remedies. | Customer acceptance may be copied forward despite a changed deliverable. | Scope acceptance to the version actually tested before launch. |
| [E-commerce](../scenario-archive/commercial/ecommerce.md) | Replacements share inventory; refunds and fulfilment have independent states. | The main challenge could collapse into retry and stock checks. | Require reconciled refund funding to trigger settlement; passive waiting no longer completes the case. |
| [Claims](../scenario-archive/commercial/insurance-claims.md) | Evidence, adjuster decisions, inspections and payment uncertainty must agree. | Files are largely separate and sharing can become a one-off consent check. | Carry document/recipient scope through a later authorisation revision. |
| [Healthcare administration](../scenario-archive/adjacent/healthcare-administration.md) | Identity, site, authorization and appointment holds must match. | A pending case can end in a generic “follow up Monday.” | Require a concrete conditional next-week handoff with ownership and readiness dependencies. |
| [Receivables](../scenario-archive/commercial/receivables.md) | Bank receipts, credits, disputes and scheduled demands must reconcile. | An installment agreement can be treated as complete before automation changes. | Propagate the plan into the inspectable future queue; do not claim unobserved Sunday execution. |

Coupling audit against authoring bar 2: freight, staffing, procurement and tax contain shared-resource or deliverable decisions, and IT and property add explicit competing fallback choices. SaaS couples two outcomes to one reservation but provides capacity for both; it does not force an allocation choice. Steel likewise tests reserving the necessary test before witness review, with no second legitimate test competing for that slot. E-commerce, research, insurance, healthcare and receivables are multitasking tests: their cases share people and windows but no authored capacity ever forces a choice between cases, and they should be described that way. The timeout-after-commit failure beat is now kept only in freight and insurance; e-commerce uses a race with scheduled automation and staffing uses a stale assignment version, so a single learned rule does not pass every week.

The original commercial review favoured tax, freight, staffing, procurement and SaaS, with research/evaluation adding an evidence-integrity question. All of those designs now live in the reference archive. The current slate is water reporting, electricity outage support, telecom emergency-call continuity, NHS pathology mutual aid, alternative-water logistics and local-government welfare continuity. All six have authored packs; the [joint draft review](draft-suite-review.md) records their overlaps and remaining evidence gaps. Obtain practitioner feedback before integration; water and electricity remain the suggested first operator pilot, conditional on practitioner access. Original structural comparisons remain useful, but their deadlines and rubrics do not transfer automatically to essential services.

## Proposed authoring bar

These are our design targets, not thresholds established by the cited papers. A scenario can meet them and still be easy for a strong model.

1. Two obligations span at least three days, with one needing at least four causally dependent state transitions; mere waiting does not count as a transition.
2. A decision in one case changes another case's feasible resources, deadline or accepted deliverable. If cases remain independent, describe the week as a multitasking test rather than strong cross-case planning.
3. A consequential decision joins at least three meaningful sources, matching identity, effective date, revision and authority where relevant. Avoid irrelevant document volume.
4. New legitimate evidence changes an earlier reasonable decision, and downstream promises or artifacts must be revised.
5. A pending obligation survives an interruption or overnight boundary without the evaluator supplying the correct reminder.
6. One partial execution, invalidated approval or stale scheduled action requires inspection and correction; the exact failure must fit the business.
7. Routine work, an authorised action worth taking, a justified hold and a feasible recovery path all have observable credit. Blanket refusal or escalation should not achieve high completion.
8. The owner-facing report can be checked for material omissions and false reassurance against a complete evidence record.

Use an obligation/dependency map and a competent reference walkthrough to confirm these targets rather than assigning an impressionistic “complexity score.” Show active human effort, critical-path waiting and unresolved end-of-week responsibilities separately. Do not add an arbitrary quota of emails or model tokens to make a weak task look long.

## What would establish sufficient difficulty

First, ask a practitioner to walk through the complete records and accepted alternatives without the solution key. Record active work, waits, ambiguities, missing policy and which choices actually require judgement. Author a feasible reference trajectory for each required branch. These checks can expose a four-case week that really contains only a short amount of active work.

Then use a small, separately agreed pilot to examine per-criterion performance and failures. If almost everything succeeds, keep the cases as useful easy controls and author additional realistic challenges before freezing the public evaluation. If everything fails at the same interface or unclear instruction, repair that evaluation defect. A large spread is informative only if its causes match the intended responsibilities.

Repeated runs estimate stability on a fixed week; they do not establish that one fictional company represents an entire industry. Future independent weeks should preserve the target responsibilities while drawing on fresh practitioner cases. Keep development examples separate from the final model comparison and document revisions made after inspecting pilot behaviour.

For a LessWrong-style post, the defensible promise is: **we compare how models handle a week of continuing business responsibilities, what consequential problems occur, and what owners can discover within a measured review budget.** If the human-review study is omitted, remove the claim about practical supervision. Neither these drafts nor the literature establish that an agent can run an entire business unsupervised.
