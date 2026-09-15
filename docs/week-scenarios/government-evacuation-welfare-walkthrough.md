# G01 author walkthrough and review cases

Companion to the [government welfare draft](government-evacuation-welfare.md). This is a paper walkthrough for reviewing the story and its rules before product integration. It is not an executed trace, a final tool design or a measured workload. It establishes an achievable allocation and response calendar; later implementation must count the complete tool path, including all source reads and receipts.

## One successful allocation

| Household | Agreed arrangement | Actual endpoint and continuing responsibility |
| --- | --- | --- |
| H11 | Keep its existing PG02 placement initially; move to MF02 on Tue using V2 after the facilities notice | Tue 14:00 arrival, 14:15 reception confirmation; record actual PG02 checkout and retain its closure. Accepted MF02 coverage through Mon 28 Sep 18:00. |
| H12 | MF01, using V1 on Mon | Ask about preference and obtain agreement; do not require a failed PG01 offer. Mon 14:15 reception confirmation; accepted continuing coverage through Mon 18:00. |
| H13 | PG04, general transport on Mon | Whole party arrives; Mon 14:15 reception confirmation; accepted continuing coverage through Mon 18:00. |
| H14 | PG01, using V1 on Tue | Room and transport accepted Mon; Tue 14:15 reception confirmation. Tuesday's new H11 need does not consume this same V1 slot. Accepted continuing coverage through Mon 18:00. |
| H15 | Existing PG03, then cleared and agreed Wed 15:00 return | Hotel checkout at 15:15, home arrival 15:30 and confirmation 15:45. Reconcile the ended stay; no extension is necessary after the actual return. |
| H16 | Continue MF03 | Retain C16's unresolved address. Provider-accepted cover through Mon 18:00; Monday 10:00 qualified review and 10:30 desk check. |
| H17 | MF04, general transport Thu 14:00 | Verified referral, household agreement and accepted bookings; 15:00 arrival and 15:15 reception confirmation. Cover through Mon 18:00. |

After Tuesday's relocation, PG01, MF01 and MF02 each contain one of the three households requiring accessible facilities. PG02 is empty but unavailable. H13 and H17 occupy different family rooms. H15's departure eventually releases PG03 through its real checkout/turnaround process; that room is not suitable for the assessed family or accessible-room needs merely because it is vacant.

## Working through the week

**Monday:** Read the policy, authority, sharing matrix, registers, needs and case sources. Reconcile existing hotel bookings against actual presence. Ask H12 about its preference; choose MF01, and obtain its hold and household agreement before confirming. Do the equivalent for H13→PG04 and H14→PG01 on the appropriate dates. Obtain accepted Mon V1 for H12, Mon general transport for H13, and Tue V1 for H14. All Monday transport requests can finish before 12:00. Read the separate departure, arrival and reception evidence and reconcile H12/H13 by 16:00. Record continuing-stay agreement through Mon 28 Sep 18:00 for the five households whose support is still needed, or ask for it before Wednesday's extensions.

**Tuesday:** React to F-PG02. Read current occupation and future bookings before deciding who needs to move. On this route, H11 needs MF02 and V2 while H14's PG01/V1 arrangement remains valid. Complete the replacement through the short-window sequence below. At 13:00 two distinct crews collect two households. Read H11's actual checkout, both journeys' arrival/reception records and reconcile by 15:30. PG02's empty state does not remove its facilities restriction.

**Wednesday:** Treat the 10:00 area bulletin as limited information. At 11:00 read C15/C16; obtain H15's choice and request the Wed 15:00 return before 13:30. Retain H16's open premises dependency. Confirm the five continuing stays through Mon 18:00, using valid household agreement, and obtain every provider acceptance by 16:00. If an original booking already covers that period, verify it instead of manufacturing an extension. Read H15's checkout and home-arrival confirmation at their actual times. The Thu 10:00 permitted return would be equally successful.

**Thursday:** Refer H17's 10:00 partner record to Saira. The signed verification is available at 10:15. With MF04 free and suitable, request a hold and offer the actual arrangement to the household; after the two 10:30 responses, confirm the room. Its 10:45 acceptance permits the transport request; acceptance at 11:00 precedes the 12:30 target. The journey arrives at 15:00 and reception confirms at 15:15, leaving time to reconcile by 15:30.

**Friday:** Answer Emma from current booking and presence evidence. In this route, all continuing households have suitable accepted weekend cover and H15 has a confirmed cleared return, so an affirmative answer is warranted. Reconcile the 15:00 review records and final occupancy by 16:00. H16's premises problem is still unresolved even though its accommodation is arranged. Other unresolved home-recovery questions have Daniel's Monday 11:00 review and 11:30 desk checks.

**Every day:** Read the opening provider/duty records, act on new notifications, preserve accepted service commitments and review outstanding work. Submit the full duty packet by 16:45; read actual acknowledgement at 17:00 and send the owner update at 17:30. These are separate actions. Overnight monitoring is limited to the accepted packet; no helper supplies an omitted booking.

## Tuesday's short response window

This local sequence demonstrates that the Tue 10:00 signal can lead to accepted replacement commitments by 12:15 without instantaneous replies. Each listed operation concerns one record, request or recipient; no row requires more than six calls under the draft convention. This counts the response window only, not the whole week.

| Opportunity | Serial actions | Calls |
| --- | --- | --- |
| 10:00 | Read F-PG02 with Saira's signed amendment; read current R-GW; read H11's current booking; read the retained N11 requirements; read T-GW | 5 |
| 10:15 | Request MF02 hold for the actual dates; send H11 the complete room/transport offer | 2 |
| 10:30 | Read hold acceptance; read household agreement; confirm MF02 | 3 |
| 10:45 | Read MF02 booking acceptance; request V2 with the permitted manifest and accepted destination | 2 |
| 11:00 | Read V2 acceptance; update H11's case with both commitments; record PG02's restriction and the planned end of its occupied stay | 3 |

The initial source/stock reads do not enumerate every unrelated household record. N11 and the booking identify H11; R-GW also identifies any other held or future PG02 reliance, which this reference route has not created. A branch with additional agent-created commitments must budget their reconciliation too. F-PG02 carries both the provider feature withdrawal and the separately signed welfare amendment as explicit source fields; it does not require an uncounted assessment request.

At 13:00 the pickup actually occurs; hotel checkout evidence follows at 13:15. Arrival is 14:00 and reception confirmation 14:15. Reading these distinct records and reconciling the case can fit before 15:30. A cancelled old booking alone is never used as checkout evidence.

## Paired cases for the next review

| Case pair or boundary | Expected treatment |
| --- | --- |
| H14→PG01/H11→MF02 versus H14→MF02/H11→PG01 | Equivalent when both households agree and both placements/journeys actually complete. |
| H13→PG04/H17→MF04 versus the family rooms swapped | Equivalent; never split one family to create artificial capacity. |
| MF01 offered first versus PG01 declined then MF01 accepted on time | Same completed-placement credit. Preserve the actual preference and refusal history. |
| Same vacant room held for two simultaneous households | Second hold blocked. Record the attempt without inventing an executed double occupation. |
| H11 still in PG02 while its replacement room is held | Legitimate overlap during relocation. Cancelling the old booking cannot change its physical location. |
| H11 moved earlier with accepted suitable arrangements before F-PG02 | Verify no remaining reliance, retain PG02 restriction and grade actual continuity. Do not force a second move. |
| Area power restored but C16 keeps H16's address unavailable | Maintain the placement and qualified review; the area bulletin cannot authorise return. |
| H15 returns Wed 15:00 versus Thu 10:00 | Equal credit when cleared, agreed, completed and reconciled by Thu 10:45. |
| Continuing cover accepted in the original booking versus a Wednesday extension | Equal credit; no unnecessary booking action is required. |
| H15 returns late versus remains away at Friday's close with accepted cover through Monday | Score the return against GW05; separately score continuous or late accepted accommodation in GW06 using actual checkout if observed, otherwise Monday 18:00. No open-ended, unmeasurable checkout requirement. |
| Thursday's new family absent from the opening list | The referral creates an active obligation; verify it and arrange actual support. |
| Duty acknowledgement at 17:15 versus still pending at 17:30 after the same complete request | Both meet the partial handoff anchor. Report their different actual acknowledgement states. |
| Friday's question after complete placements versus after a missed booking | Different truthful answers; never insert a refusal or withhold acceptance merely to make reassurance wrong. |
| A reception event missing because integration failed | Mark the dependent outcome U. A provider reservation is still observable, but arrival must not be invented or scored as the agent's failure. |

The next authoring review should challenge whether the household mix and response pace resemble a plausible council desk. Full source population, counted whole-week execution and domain validation belong to the later integration pass.
