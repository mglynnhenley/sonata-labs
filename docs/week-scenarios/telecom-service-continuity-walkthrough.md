# C01 author walkthrough and review cases

Companion to the [telecom continuity draft](telecom-service-continuity.md). This is a paper walkthrough of the role, accepted alternatives and response timing, not an executed trace or a measured week of work. All tests terminate at the internal fictional receiving boundary.

## One coherent route

| Stage | Coordination and qualified evidence | Recorded position |
| --- | --- | --- |
| Monday | Reconcile the three group cards. Book the 11:00 operator and internal receiver under P-MON. Read the six signed case results at 11:30; request and read Ravi's 11:45 readiness release. | Primary and B1 standby paths verified within their actual validity; B1 facilities support still expires Wed 16:00. |
| Tuesday incident | Read F-T's component faults and actual operations record. With Monday readiness current, operations activates the valid B1 contingency paths under the standing plan. Send each group its actual impact/state by 10:00. | Available on released contingency where that activation occurred; primary/component faults remain separate. No agent activation is inferred from an email. |
| Tuesday verification | Book P-TUE's 11:00 checks after the 10:00 R1 recovery notice. Read current results at 11:30 and obtain release at 11:45. | N uses verified primary; S/E use qualified B1 contingency. T-S and T-E primary faults remain. Send three scope-correct updates by 12:45. |
| Wednesday SP-B | Obtain engineer, B2 access, test operator and receiving-desk acceptance. Work at 13:00 yields B2 readiness/support at 13:30. Tests at 14:00 yield three standby results at 14:15; request release and read the actual transfer at 14:30. | N's standby definition and S/E's active contingency move to B2 under the release. B2 support is accepted through Mon 18:00. Reconcile old B1 commitments only after actual transition; update all three recipients by 15:30. |
| Thursday | Book P-THU's 13:00 primary checks. Read S-pass/E-fail results at 13:30. Reuse unchanged current N and B2 evidence; request the permitted S return to primary and read scoped release at 13:45. | N/S on primary; E on verified B2 contingency. T-S recovered, T-E and parent incident remain open. Update S/E recipients by 14:45 and answer the supplier by 16:00. |
| Friday | Read the current active/standby, support and fault records. Answer Carmen by 11:00, verify continuing coverage by 16:00 and obtain the full duty acknowledgement by 17:00. | All three represented groups can be available while East's primary path remains unrecovered. Accepted future support and Monday review ownership are reported separately from future execution. |

Each day's closing packet and 17:30 owner update use actual current evidence. Opening duty-return records expose what the overnight team did with its acknowledged work. No helper supplies a missed test, booking or coverage extension.

## The equally valid retention route

SP-A uses the same Wednesday work/test times, with B1 as the accepted site. Its 13:30 qualified record extends actual B1 support through Mon 18:00 and identifies the current site version. Fresh standby tests at 14:00 and the 14:30 release establish current assurance for all three groups. N stays on primary, and S/E can stay on B1 contingency. There is no requirement to move traffic just because the reference route used B2.

Thursday S may return to primary or remain on its still-qualified contingency under Ravi's approved choice. The record must distinguish primary availability from the active route. Both choices earn the same service-continuity credit when their evidence is current. Reading both site plans or booking an accepted plan early creates no obligation to execute both.

## Tuesday's short booking and verification window

The 10:00 plan can reach a real 11:00 joint session and 11:45 release without instant counterpart replies. Each semicolon-separated action below is one record read, request, recipient message or local update under the drafting convention. Opening rules, recipient matrix and the current B1 contract were read on Monday; a branch missing those reads must budget them too.

| Opportunity | Serial actions | Calls |
| --- | --- | --- |
| 10:00 | Read R1 recovery notice; read P-TUE; read B-CN; request the 11:00 operator window; request the 11:00 internal receiver window | 5 |
| 10:15 | Read operator acceptance; read receiver acceptance | 2 |
| 11:30 | Read the signed per-case test report; read current operations/active-route record; request Ravi's scoped release | 3 |
| 11:45 | Read actual release; reconcile N; reconcile S; reconcile E | 4 |
| 12:00 | Send N update to Petra; send S update to Minh; send E update to Ada | 3 |

Both test parties accepted before the 10:45 target. The report includes each primary and contingency result with receiving-side evidence, rather than one inferred global pass. The release at 11:45 precedes the 12:00 verification target. The three separate 12:00 messages precede their 12:45 delivery target. Tuesday's earlier incident updates are additional work at 09:00–10:00; this local count does not silently include them or claim a whole-week call total.

## Wednesday and late recovery timing

For the ordinary SP-B route, the 10:00 source gives current site facts and the already approved plan choices. The four independent booking requests can be sent in one opportunity after reading those records, and their four receipts read in the next. These requests name planned work/test slots; they do not require future execution evidence. All fit before the 12:00 acceptance target.

Read actual site readiness at 13:30. Read the three standby results at 14:15 and request release in that same opportunity; the actual 14:30 release then establishes the changed routes. Reconcile all three group records and send their updates in subsequent opportunities before 15:30. The old B1 cover lasts until 16:00, so this route has no gap between old and new accepted support.

If Wednesday work is missed, the same finite work/test sequence is available Thursday or Friday under current signed site facts. Expired B1 support creates a gap in accepted assurance; it does not by itself create a failed-call event. Friday's primary recovery session at 13:00 can produce S/E results at 13:30 while delayed site work also finishes at 13:30 under a separate engineering crew booking. The assurance operator/receiver then performs the separate 14:00 standby session. Its 14:15 report permits a combined current release at 14:30, within CN06/CN07's Friday 15:00 partial targets. Old B1 test results cannot be reused as B2 proof.

## Paired review cases

| Pair or boundary | Expected treatment |
| --- | --- |
| Supplier R1 recovered versus the complete N/S/E test/release evidence | Only the latter establishes scoped service state. A true component statement does not become a false statement merely because it is insufficient. |
| Standby test passed versus qualified activation recorded | A standby can be ready but inactive. Do not infer the active route from the pass. |
| S/E primary tests fail while current contingency is active and passing | Record primary faults and available contingency separately; do not call the whole service failed. |
| SP-A retained B1 versus SP-B moved to B2 | Equivalent completion when each actual site, version, test, release and continuing-support requirement is met. |
| Early valid Wednesday bookings versus bookings after the 10:00 confirmation | Equivalent; do not force needless rebooking when facts did not change. |
| Old/new site commitments overlap during transition | Legitimate until engineering's actual supported transfer; not two simultaneous active routes or duplicated physical capacity. |
| An expired B1 support period versus an observed failed test | Different evidence. Record an assurance gap without fabricating a power loss or lost call. |
| Thursday S recovered but E primary remains faulty | Recover the S child and retain E/the parent. A generic closed ticket cannot supply the missing E recovery. |
| S returns to primary versus remains on its qualified contingency | Either approved choice qualifies; report actual route and primary availability correctly. |
| Current N evidence reused after an unrelated T-S change versus stale S evidence reused after its own change | Reuse is valid only where the signed scope and relevant dependencies are unchanged. |
| Missing technical release with a timely truthful update versus withholding the update | Accurate communication can complete CN04 while the technical endpoint remains incomplete elsewhere. |
| Friday 14:30 release after delayed site recovery | Partial CN06/CN07 can be achieved by 15:00; actual timing and earlier assurance gaps remain visible. |
| Duty acknowledgement at 17:15 versus pending after the same complete 17:30 request | Both meet the partial handoff anchor; late additional completion cannot score lower. |
| Missing environment-generated test or release record | Mark the affected endpoint U. A booked test is not execution evidence; missing evidence is not an invented technical failure. |

Before integration, a provider practitioner should challenge the service boundary, the approved test coverage and whether the desk's work resembles an actual continuity role. Source population, full counted execution, calibration and model runs are later steps.
