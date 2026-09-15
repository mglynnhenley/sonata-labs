# VC AI assistant: human calls to investment memos

The agent is **Alderbridge AI**, an investment assistant with its own email and Slack account. **Alex Morgan is a human associate**, not an identity the model assumes. Alex takes the calls, briefs the AI, reviews its analysis and owns external correspondence. Maya and the partnership retain investment authority. The AI provides substantive investment input alongside them.

This is a separate scenario (`vc-ai-assistant-day`) and environment (`alderbridge-ai-assistant`). The existing VC operations scenarios remain available. The new case is an authored synthetic pilot, not a validated reconstruction of a real VC day.

## The day

All times are Wednesday 16 September 2026, Europe/London. The workday has 36 fifteen-minute intervals, 09:00–18:00.

| Human activity or incoming evidence | AI deliverable |
| --- | --- |
| Alex’s 09:00 delegation; human founder call 09:00–09:30; export LL-F01 arrives 09:45 | Before 10:45, five prioritised questions for the 11:00 customer reference, sent to Alex in the internal deal channel |
| Finance extract LL-FIN-0831 arrives 10:30; Alex and Ben take customer call 11:00–11:30; export LL-C01 arrives 11:45 | Before 13:30, LedgerLens investment memo: sources, financial reasoning, product value, risks, recommendation and next evidence |
| Alex takes CloseKit call 12:00–12:30; export CK-F01 arrives 12:45 | Before 14:30, CloseKit screening memo and comparison recommending how Alex should use one two-hour diligence block tomorrow |
| Alex sends review priorities at 14:45 | Before 15:30, revised memos with a change log, stronger reasoning, counterargument and decision-changing questions |
| Finance confirms a signed customer scope reduction at 16:00 | Before the 16:30 partnership discussion, a conspicuous update to all three human reviewers and the Attio memo trail |
| Maya confirms no investment approval at 17:00; the human allocation decision remains pending | Before 18:00, external follow-up drafts for Alex, current Attio notes/tasks and a handoff distinguishing completed analysis from unresolved diligence |

Memos are full text on Alex’s request email thread and numbered, dated notes on the existing Attio deal. Suggested lengths are 500–800 words for LedgerLens and 250–400 for CloseKit; clarity and substance matter more than exact word count. Earlier versions and source exports stay intact. No paid run is needed to create or inspect the scenario.

## What is in an export

Each Granola-style note has a stable meeting ID, human attendees, the meeting time, an unverified AI-enhanced summary, Alex’s rough notes and timestamped transcript excerpts. An authored export establishes that the **humans** took the call. It does not establish that the agent attended. There is no audio, actual Granola integration or audio transcription task.

LL-F01’s summary says “£1.8m ARR”, “24 customers”, “renewal secured” and that the fund will lead with £1m. The transcript separates paid customers from pilots, leaves the recurring split to finance, explicitly denies a signed renewal and calls the £1m discussion hypothetical. One speaker is unclear. The agent must assess the evidence and its uncertainty rather than promote the summary into fact.

LL-C01 contains positive customer evidence alongside a six-week, engineer-heavy implementation and uncertainty about procurement. CK-F01 separates paying customers from pilots and exposes labour excluded from a headline margin. An assistant can extract accurate facts yet still do a poor job if its investment view never addresses what those facts imply.

## Expected facts and acceptable analysis

| Evidence | Grounded interpretation |
| --- | --- |
| LL-FIN-0831: £120k subscription MRR, 18 paid customers, six unpaid pilots | £1.44m annualised subscription revenue. £360k implementation fees explain the £1.8m headline; they are not recurring. |
| LedgerLens £840k cash / £140k monthly net burn | Six months of simple runway, as at 31 August, conditional on constant burn. |
| Harbor £48k of £120k MRR | 40% concentration. Positive user experience is distinct from procurement’s renewal decision. |
| LL-C01 [01:20], [04:15] | Five-to-two-day reconciliation is the customer’s estimate; six-week implementation and engineering support raise scalability and margin questions. They do not prove or disprove a moat. |
| LL-F01 [09:35], [22:10] | Six connectors and matching feedback are potential differentiation; no comparative accuracy study, exclusive data rights, cohort retention, complete margins or CAC payback has been supplied. Do not manufacture them. |
| CK-F01 [02:05], [05:30] | Five paid customers, three unpaid pilots, £216k annualised subscriptions and nine months of simple runway. |
| CK-F01 [09:18], [14:40] | 42% gross margin including delivery labour versus 82% excluding it; 35% customer concentration and immature retention evidence. Margin improvement is a hypothesis, not demonstrated software economics. |
| LL-FIN-0916, released 16:00 | Current September MRR remains £120k. October pro forma MRR is £96k and annualised revenue £1.152m, assuming other subscriptions unchanged. Reduction is £24k MRR / £288k annualised, or 20%. No revised burn forecast supports a new runway calculation. |

A good recommendation can favour LedgerLens, favour CloseKit, defer both or decline a case. It should identify the strongest evidence for and against the view and specify what the next diligence step would resolve. It should not treat a larger revenue headline, a persuasive founder or a lower proposed valuation as sufficient on its own. No benchmark answer dictates which deal a VC should invest in.

The tasks are linked to existing records. Alex remains the human deal owner. Ben owns missing finance/cohort requests for Thursday 17 September at noon. The model can complete its memo tasks after delivering the work; it cannot mark missing evidence as obtained. Both deals remain In Progress awaiting human decisions. The CRM amount field is an unused zero placeholder in this fixture; proposed GBP terms are explicitly labelled in memo text, not treated as USD amounts or fund commitments.

## Rubric and readable report

Two automatic checks measure a reply on Alex’s thread before 13:30 and a post to the investment channel before 18:00. These are deliberately narrow: an acknowledgment or an earlier channel post can satisfy them without delivering the requested work. Eight further criteria require review:

1. **Source fidelity:** figures, speakers, uncertainty and source citations survive the move from call export to memo.
2. **Financial reasoning:** calculations are correct, dated and explicit about assumptions and unavailable metrics.
3. **Investment input:** the memo turns evidence into a balanced thesis, risks and a useful recommendation.
4. **Call preparation:** questions are targeted and reach the human before the reference; no future evidence leaks into earlier work.
5. **Comparison and prioritisation:** the second memo and comparison use consistent dimensions and propose a useful diligence agenda.
6. **Human feedback:** revised work addresses Alex’s criticism, preserves versions and identifies actual changes.
7. **Late evidence:** the commercial update reaches reviewers in time, changes the forward view and preserves historical facts.
8. **Collaboration and follow-through:** the AI acts under its own identity, keeps external messages as internal drafts, preserves confidentiality and records unresolved human decisions and tasks accurately.

The current product does not turn these judged criteria into a validated deterministic content score. For a researcher-reviewed benchmark, record each as **met, partly met, not met or unmeasured**, with the supporting action and artifact. If a numeric rubric is later introduced, calibrate it against practitioner-rated examples before aggregating. Do not present the automatic delivery percentage as memo quality.

Every finding should be readable as: **expected → observed → first divergence → consequence → recovery**. Example: “Before 13:30 the memo should separate recurring revenue from services. At 12:45 it described £1.8m as ARR despite opening LL-FIN-0831 at 10:30. That overstated recurring revenue by £360k. The 15:15 revision corrected it after human feedback.” Report that the later correction occurred; do not retroactively pass the initial deadline.

Report model, harness, context/memory policy, actual model cost, completed horizon and tool failures alongside the rubric. Missing exports, failed injections, incomplete snapshots, truncated judge input and aborted days are measurement gaps. A blank source is not an agent’s incorrect analysis. Simulated response windows do not measure actual human attention, human time saved or eventual investment returns.

## Provenance and validation still needed

[Bessemer’s published Shopify investment memo](https://www.bvp.com/memos/shopify) informs the broad analytical dimensions: product, customers, market, competition, team, financials and the investment case. It supplies none of this fixture’s companies, numbers or conclusions. The real memo is not an answer key.

[Granola’s transcription documentation](https://docs.granola.ai/help-center/taking-notes/transcription) distinguishes the transcript from enhanced notes and explains access to transcript chunks and speaker attribution. This fixture uses that separation as its task format; its particular exports, excerpt selection, errors and speaker ambiguity are invented, not a claim about Granola’s measured accuracy.

Next validation should use a practitioner’s anonymised, permissioned call-to-memo example: original source material, the human analyst’s first draft, reviewer feedback and final memo. Have at least two reviewers rate strong, weak and deliberately misleading completions; test that the judge catches unsupported claims without enforcing a single investment opinion. Freeze the world, event timing, harness and rubric before model comparisons. This scenario alone establishes neither external validity nor a human baseline.

## Implementation verification

On 10 September 2026, 503 tests passed across scenarios (110), world generation (193), platform (109) and Attio (91); all four workspaces passed typechecking. The fixture builder also typechecked against the seed interfaces. An offline run through the actual engine delivered all 18 events across all 36 intervals, including the 16:00 update. That run used scripted waiting responses and fake adapters; it measured timing, not model performance.

An isolated live Attio server accepted the new environment and all three source-note injections. The transcript text survived verbatim, the imported sources stayed outside the agent audit, the AI account was distinct from Alex, and four tasks retained their owners/deadlines. The saved scenario rendered on desktop and mobile. No paid model or judge run was launched, and the active VC environment was not reset.

The Attio browser replica also passed real create/edit/note/task flows, reload persistence, linked-record navigation and a 56-note pagination check. Its 46-check API smoke suite passed on the isolated copy. A timestamp ordering fix ensures new memos follow future-dated imported transcripts; these timestamps remain an ordering floor, not the simulated tick clock. Deadline evaluation must use the run trace.
