# VC investment team: committee preparation

Status: synthetic pilot v1, awaiting practitioner validation. No model performance or human baseline has been measured. Scenario: `vc-investment-day`. Backlog: `alderbridge-ventures`.

## The job

Alex is an investment associate at fictional Alderbridge Ventures. Prepare a short LedgerLens briefing before 15:00 for the partners' 16:00 investment committee. Meanwhile, screen two inbound pitches, organise a customer reference, respond to material updates and leave a useful handoff. Work takes place in Gmail, Slack and Calendar on 15 September 2026, 09:00–18:00 Europe/London.

The environment opens with five email threads, three internal Slack channels and six calendar events. Seventeen scheduled events then arrive over the day. Every required source is available as message text. Written customer evidence arrives independently of whether the agent arranges the call; the calendar does not prove attendance. No document, spreadsheet or CRM tool is assumed.

Alex may send correspondence and make recommendations. Partners retain investment authority. Appropriate questions and escalation are allowed; there is no no-escalation criterion.

## Provenance

[Bessemer's published Twilio investment-process example](https://www.bvp.com/atlas/an-inside-look-at-our-investment-process-for-twilio/) describes compiling diligence into investment recommendations and using customer evidence, including risks associated with the customer base. This supports the choice of work to simulate. It does **not** establish this pilot's chronology, fund mandate, financial corrections or committee process. All names, figures and messages here are invented. We do not model Bessemer or claim this is how every VC fund works.

To make a real-day benchmark, obtain an authorised, anonymised source packet and a practitioner's account of the sequence of events, decisions and acceptable outputs. Record each item as original, redacted, reconstructed or invented. Freeze the case and rubric before comparing models. Public successful-deal memos alone cannot supply a representative workday or an unbiased selection of outcomes.

## What happens and what good work looks like

| Company time | Evidence / request | Expected work |
| --- | --- | --- |
| Opening history | Written mandate, provisional LedgerLens summary, unresolved diligence and diary | Read enough history to understand the job; treat founder figures as provisional. |
| 09:00 | Maya requests the briefing before 15:00; committee is fixed at 16:00 | Deliver the briefing on Maya's thread, with Ben included, before 15:00. |
| 09:30 / 09:45 | Weekender is a consumer travel marketplace; CloseKit is seed-stage finance software | Decline the clear non-fit before noon. Give CloseKit a qualified next step before 13:00; ask for missing metrics or use the figures supplied at noon. |
| 10:30 | Elliot cannot do 13:30; offers 14:00 or 16:00 | Move the existing reference to 14:00–14:30, retain Alex/Ben/Elliot, confirm before 12:30 with relevant questions. Leave committee unchanged. |
| 11:00 | Sam replaces Monday's headline figures with a dated finance extract | Use £150k subscription MRR × 12 = £1.8m annualised subscriptions; identify £600k services separately. Cash £900k / monthly net burn £150k = six months, assuming constant burn. Harbor pays £60k / £150k = 40% of MRR, with no signed renewal. |
| 12:00 | CloseKit supplies £18k MRR, five paid customers, three unpaid pilots; £360k cash and £40k burn | Update the screening record from available facts. Do not treat eight organisations as eight paying customers or fit as investment approval. |
| 14:30 | Elliot supplies written product feedback and uncertain renewal status | Include product benefits as customer-reported evidence; distinguish an unsigned renewal from a current contract. Do not invent a call transcript. |
| Before 15:00 | Briefing deadline | Give the current facts, sources, risks, recommendation and open questions. Market size, legal documents and cap table remain unverified. A reasoned recommendation to continue diligence or defer is acceptable. |
| 15:15 | Harbor decides not to renew after 30 September | Send an explicit update on the briefing thread to Maya and Ben before 16:00. Current MRR remains £150k through September. A £60k loss would leave £90k MRR / £1.08m annualised subscriptions after expiry, if everything else stays constant. The forward calculation is useful, not required. Do not mechanically recalculate burn without cost assumptions. |
| 16:30 | Maya confirms no commitment is authorised | Reply to Nia before 17:00 with truthful status and a concrete follow-up. Do not disclose Elliot's restricted comments or internal deliberations. |
| 17:15 | Ben requests a handoff | Before 18:00 post all three deals' status, open questions and next-step owners in #investment-team. Ben can own tomorrow's diligence. |

## Rubric and report

The saved scenario carries eight criteria. Four automatic checks establish that replies landed before their deadlines and that the reference event changed time. Their descriptions deliberately state this narrow scope. A wrong memo can pass a delivery check; the wrong calendar move can pass a movement check.

Four `judged` criteria cover briefing quality, reference coordination, triage/handoff, and late-update/authority handling. The existing judge receives these for narrative review; it does not produce a calibrated, structured pass/fail for each content subcondition. They must not be silently counted as automatic passes or presented as a validated task-success percentage. Until structured content assessment is implemented and validated, use the automatic rows as diagnostics and review these four criteria separately. The pilot is not ready for a published model ranking from its headline score.

For a researcher-facing report, use one row per deliverable: expected result; actual result with message/event IDs, recipient and time; pass/fail/unmeasured; first observed error; subsequent correction. Include supporting source IDs. In a review, mark a content criterion passed only when all stated obligations are evidenced; failed when available evidence establishes a missed obligation; unmeasured when required evidence or intervals are missing. Judge prose alone does not become a deterministic score.

Distinguish these errors:

- **Wrong source:** quotes the old £2.4m as recurring revenue after receiving the correction.
- **Wrong calculation:** gives eight months of runway from the superseded cash balance.
- **Missed update:** an accurate 14:45 briefing is left unchanged after 15:15.
- **Missed task:** the main briefing is finished but inbound deals have no answer or owner.
- **Wrong action:** the reference moves to 16:00 and collides with committee.
- **Overstated authority:** tells the founder an investment is approved without authorisation.
- **Wrong recipient:** forwards restricted customer evidence or another founder's metrics outside the fund.
- **Harness limitation:** a source never arrived, a tool failed, the run ended early, or the judge lacked part of the trace. Report this as unmeasured where it prevents a conclusion.

Report task outcomes, agent spend, evaluation overhead, tool calls, wall time and simulated duration separately. Record the model, prompt, harness, tools, world/director and judge configurations. A model plus its harness is the comparison unit. This tests operational work with changing information, not future investment returns or the ability to run a fund end to end.

## Validation before publication

1. Have a fund practitioner replace or validate the source packet, workflow and expected outputs. Keep redactions and synthetic additions visible.
2. Establish a human or reviewed reference completion and deliberately flawed completions (stale revenue, missed update, leaked reference) to test grading sensitivity.
3. Validate structured content checks against independent review; verify evidence includes late-day messages and actual recipients. Keep unmeasured conditions separate from failures.
4. Freeze replay conditions. Run repetitions and held-out variations; do not make a long-horizon claim from one scripted day. Price runs before launch and seek approval for a matrix.

Potential follow-on cases, not yet implemented: a partner inbox handover with overdue diligence; two deals competing for the same committee slot; a founder withdrawing customer-reference consent; and a multi-day case where a promised document arrives late. Derive the first published variants from real examples rather than adding arbitrary interruptions.

## Implementation verification

Local verification on 10 September 2026: 368 tests passed across scenarios, world and platform; all three workspace typechecks passed. An offline execution through the real engine completed all 36 intervals and injected all 17 scheduled events, including the 15:15 change. It used fake adapters and scripted waiting responses, so it measures scheduling only. The saved scenario API, review page, scenario listing and mobile layout were checked against the running dashboard. No paid agent or judge run was launched, and no running clone was reset.

The cast/backlog consistency check exposed a normalisation defect that discarded authored Slack channel privacy. Normalisation now preserves that setting, with regression coverage. This verifies preservation of the configuration, not a full access-control audit of the Slack clone.
