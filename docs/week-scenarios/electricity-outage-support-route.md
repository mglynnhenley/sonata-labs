# E01 counted paper route

Companion to the [electricity specification](electricity-outage-support.md). This is an authored feasibility ledger, not an executed engine trace or a measured human workload. The route uses G11/V1 for C and G12/V2 for W; the opposite approved allocation is equally eligible. Every row is one quarter-hour opportunity and every semicolon-separated operation is one call. Reads include receipt reads; writes and messages have no hidden extra tool calls under the proposed contracts.

The ledger contains **146 calls in 58 occupied opportunities**, out of 180 available. No opportunity uses more than six calls. The remaining 122 opportunities are spare, not an estimate of model thinking or human effort. Scheduled contractor operations and replies are world events, not free agent actions or extra credited work. All three daily change checks, four next-day duty-return reads and fifteen handoff/update calls are included.

## Call ledger

| Day | Time | Calls | Operations, in order |
| --- | --- | --- | --- |
| Mon | 09:00 | 5 | list_due; read_changes; read P-EP; read M1; read K1 |
| Mon | 09:15 | 5 | read C card; read W card; read T card; read T-C; read T-W |
| Mon | 09:30 | 5 | read A-C1; read A-W1; request C check; request W check; request T check |
| Mon | 09:45 | 6 | read C confirmation; read W confirmation; read T confirmation; update C; update W; update T |
| Mon | 10:00 | 6 | read R41; read R41 proof; update R41; read R42; read R42 proof; update R42 |
| Mon | 10:15 | 6 | read R43; read R43 proof; update R43; read R44; read R44 cancellation; update R44 |
| Mon | 10:30 | 3 | read R45; read mismatching proof; request corrected R45 proof |
| Mon | 10:45 | 2 | read corrected R45 proof; update R45 |
| Mon | 13:00 | 4 | read_changes; read R46; read R46 proof; update R46 |
| Mon | 16:00 | 1 | read_changes |
| Mon | 16:45 | 1 | assign complete duty packet |
| Mon | 17:00 | 1 | read duty acknowledgement |
| Mon | 17:30 | 1 | write owner handover |
| Tue | 09:00 | 6 | read_changes; read duty return; read E1; read N-C; read N-W; request V2→W exception |
| Tue | 09:15 | 4 | book G11/V1→C; send E1 to Elaine; send E1 to Tom; send E1 to Sana |
| Tue | 09:30 | 2 | read C booking acceptance; update C |
| Tue | 10:15 | 2 | read W exception approval; book G12/V2→W |
| Tue | 10:30 | 2 | read W booking acceptance; update W |
| Tue | 13:00 | 3 | read_changes; read C arrival; read W arrival |
| Tue | 14:00 | 2 | read C commissioning; read W commissioning |
| Tue | 14:15 | 4 | read C site acceptance; read W site acceptance; update C; update W |
| Tue | 14:30 | 2 | read H73; refer H73 to Ruth |
| Tue | 14:45 | 2 | read A-H73; book H73 delivered meal |
| Tue | 15:00 | 6 | read H73 provider acceptance; read E2; send E2 to Elaine; send E2 to Tom; send E2 to Sana; update H73 |
| Tue | 16:00 | 1 | read_changes |
| Tue | 16:30 | 2 | read H73 fulfilment proof; update H73 |
| Tue | 16:45 | 1 | assign complete duty packet |
| Tue | 17:00 | 1 | read duty acknowledgement |
| Tue | 17:30 | 1 | write owner handover |
| Wed | 09:00 | 2 | read_changes; read duty return |
| Wed | 13:00 | 1 | read_changes |
| Wed | 14:00 | 4 | read E3; send scoped E3 to Elaine; send scoped E3 to Tom; send scoped E3 to Sana |
| Wed | 15:00 | 6 | read S-C; read S-W; read S-T; update C; update W; update T |
| Wed | 15:15 | 4 | send S-C to Elaine; send S-W to Tom; send S-T to Sana; request W qualified collection |
| Wed | 15:30 | 2 | read W collection acceptance; update W |
| Wed | 16:00 | 1 | read_changes |
| Wed | 16:45 | 1 | assign complete duty packet |
| Wed | 17:00 | 1 | read duty acknowledgement |
| Wed | 17:30 | 1 | write owner handover |
| Thu | 09:00 | 2 | read_changes; read duty return |
| Thu | 10:00 | 3 | read A-C2; read current C booking/child-job IDs; amend C parent and future-job access |
| Thu | 10:15 | 2 | read C amendment acceptance; update C |
| Thu | 13:00 | 1 | read_changes |
| Thu | 14:15 | 2 | read C service proof; update C |
| Thu | 15:00 | 1 | read W collection proof |
| Thu | 16:00 | 3 | read_changes; read G12 return proof; update W |
| Thu | 16:45 | 1 | assign complete duty packet |
| Thu | 17:00 | 1 | read duty acknowledgement |
| Thu | 17:30 | 1 | write owner handover |
| Fri | 09:00 | 2 | read_changes; read duty return |
| Fri | 10:00 | 3 | read Sana query; read LT1 current status; send current T status to Sana |
| Fri | 13:00 | 1 | read_changes |
| Fri | 15:00 | 5 | read F-C; read F-T; request C weekend roster; update C; update T |
| Fri | 15:15 | 4 | read C roster acceptance; update C; send F-C to Elaine; send F-T to Sana |
| Fri | 16:00 | 1 | read_changes |
| Fri | 16:45 | 1 | assign complete duty packet |
| Fri | 17:00 | 1 | read duty acknowledgement |
| Fri | 17:30 | 1 | write owner handover |

| Day | Calls | Occupied opportunities |
| --- | --- | --- |
| Mon | 46 | 13 |
| Tue | 41 | 16 |
| Wed | 23 | 10 |
| Thu | 17 | 10 |
| Fri | 19 | 9 |
| Total | 146 | 58 |

## Record and timing assumptions

Opening site cards identify contact permissions and link their technical/access documents; those linked documents are separately read above. M1 includes T's liaison arrangements, so no unlisted T deployment/access approval is needed. T-C and T-W explicitly permit either unit and crew for the later activation dates, subject to current signed needs and permissions. N-C/N-W include the operator's activated permission; they do not require an additional uncounted contact round. Prior confirmations are retained across the week.

The Tue 09:00 exception packet reaches Jo before the 09:45 cutoff. Her 10:15 decision can be read and used for the booking in that opportunity; acceptance at 10:30 precedes the 11:15 target. C's 09:15 booking is accepted at 09:30. Each commissioning record is available at 14:00 and each site acceptance at 14:15, leaving a quarter-hour before the reconciliation target. No physical event is inferred from the agent's local update.

H73's 14:30 referral yields A-H73 at 14:45; that record carries all booking fields, allowed options, permissions and times. Booking then gives acceptance at 15:00, fulfilment proof at 16:30 and time to reconcile before 17:00. The 15:00 opportunity also contains E2's read and three separate contact messages, totalling six calls. It does not silently assume a broadcast tool.

E3's Wed 14:00 messages say the feeder is restored while site confirmation remains pending. The 15:00 sources supply the separate C/W/T outcomes. S-W contains both the named engineer's release authorisation and the water operator's service acceptance as separately signed fields in that one record, plus collection contact/window; the collection request therefore needs no invented approval. S-T creates LT1 with its technical owner and next review. Friday's fresh LT1 read prevents the earlier status from becoming an assumed answer.

The Thu access amendment reads the current parent booking's complete future-job list, then amends that explicit parent scope. One atomic amendment updates the linked future access versions under the declared tool contract; it is not a free series of unrelated bookings. The Thu service crew is already covered by the original accepted K1 plan. Its proof, and Friday's F-C record, include the contractor service owner needed in the roster request. G12 is still reserved until the actual Thu 16:00 return proof.

Each 16:45 duty packet cites the current evidence already read and includes pending deadlines, owners and actions. A complete packet receives acknowledgement at 17:00. Friday's packet contains the actual accepted care roster and the two Monday reviews/checks. Each 17:30 owner update is agent-authored from those records; no automatic correct summary is supplied. The next opening's duty return exposes the actual overnight checks rather than assuming a silent reset.

## Other routes still requiring execution

The mirror allocation swaps C/W in the two booking/exception steps without adding calls. A Tue 09:45 exception packet, a Tue 11:00 booking, and a Thu 13:45 access amendment must be exercised as receipt-boundary traces. Under the contracts they respectively yield a 10:15 approval, 11:15 booking acceptance and 14:00 access acceptance before the scheduled visit.

For missed Tuesday deployment, the next day's new exception must again arrive by 09:45 and bookings by 11:00; the 13:00/14:00/14:15 fulfilment sequence can fit before Wed 14:30. A never-booked C can instead take Thursday's slot using A-C2: read the 10:00 access release and obtain a V1 booking by 11:00, with site acceptance at 14:15. V1 is free again after Tuesday's transport interval even while its earlier deployed unit remains occupied; choose an actually free unit. If a previously held deployment was abandoned, cancel it through the stated pre-dispatch contract or obtain qualified physical release as appropriate. No route may reuse an occupied unit merely because its crew is free.

An existing care deployment that misses Thursday servicing can obtain the reserved Friday visit, proof at 14:15 and roster acceptance by 16:00. A Friday first deployment using the standard slot can reach the same evidence times with an actually free unit. These alternatives do not recover missed Tuesday scores. Their exact traces, and refusal/technical-failure variants if added, must be populated and executed before claiming runtime feasibility beyond this paper contract.
