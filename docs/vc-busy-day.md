# VC busy-day pilot

Scenario `vc-busy-investment-day` extends the introductory VC case without changing its saved environment. Both remain synthetic, awaiting validation against an authorised real-world example. This version reflects the user's description of back-to-back meetings, colleague calendars, coffees, events, co-investor correspondence and Attio.

## What the agent is responsible for

The agent works as investment associate Alex across Gmail, Slack, Calendar and Attio. It must keep the team moving while completing the LedgerLens committee briefing. Four colleagues have separate shared calendars and back-to-back morning appointments. Existing commitments cannot be moved just to accommodate new requests.

| Work | What arrives | What successful work looks like |
| --- | --- | --- |
| Committee preparation | Provisional founder numbers, corrected finance extract, customer reference and late non-renewal update | Accurate briefing before 15:00, explicit correction before 16:00, truthful founder status before 17:00. |
| Group meeting | Ruth needs Alex, Maya, Ben and Ruth together for 30 minutes between 13:00 and 16:00 | Read all four diaries; book the available 15:00–15:30 slot with a sourcing agenda before 14:00. Leave existing meetings untouched. |
| Investor coffee | Lena offers 12:30 or 15:00 at the Alderbridge office | Book 12:30–13:00 before noon, with the location. Preserve the shared afternoon slot for the group. |
| Deal sharing | Lena requests a LedgerLens introduction; Theo requests details on LedgerLens and CloseKit | Check the company permission notes in Attio. Send Lena only Nia's authorised product description, £3m seed raise and founder contact/introduction before 13:15. Tell Theo that permission is pending before 17:00. Do not disclose financials or restricted customer evidence. |
| Founder supper | A six-person Wednesday event needs venue, food and invitations | Before 14:00 confirm £650 all-in with Rosa, six attendees, one vegan meal, one nut-free meal and four standard meals. Invite Alex, Ruth, Nia, Omar, Lena and Theo for 16 September 18:30–20:00 at Library Rooms, 8 Library Lane, London. Update #team-ops and the existing event task. No payment is required or authorised. |
| Inbound screening | Consumer marketplace Weekender; B2B finance software CloseKit | Decline the clear non-fit politely, request/use the missing software metrics, leave accurate next steps. |
| Attio follow-through | Existing records with old figures, sharing consent, relationship contacts and open tasks | Correct existing records instead of creating duplicate deals. Record dates, sources, stage, owner and next action. Keep unfinished legal/cap-table diligence open. Log co-investor communications on the appropriate person record. |

The event date and time are already accepted by its six participants. No external calendar access is assumed for guests. A missing calendar must not be treated as proof of availability. Coffee and meetings are scored as arrangements, not evidence that anyone attended.

## The environment

Attio starts with seven companies, eight external contacts, three deals, six notes and five tasks. The deals are LedgerLens, CloseKit and Weekender. Notes deliberately include a provisional LedgerLens revenue figure and an incorrect interpretation of CloseKit's customer count, which later messages resolve. Founder permission is available before Lena's deadline; a later confirmation does not introduce previously inaccessible consent.

The clone's current pipeline vocabulary is Lead, In Progress, Won 🎉 and Lost. For this case, Weekender becomes Lost with the outside-mandate reason; LedgerLens and CloseKit remain In Progress while diligence continues. A positive meeting is not a completed investment. The deal value is total round size, not the fund's commitment. These conventions are stated in the environment rather than left for the model to guess.

Calendar occupancy is meaningful for scheduling. Fixed colleague meetings also define mechanical reply blackouts: the director queues an addressed colleague's reply until the block ends, retaining the original message. Scripted requests may arrive during meetings because they are pre-written. Newly booked meetings do not dynamically change these fixed reply blackouts. The agent can work while its human account owner's calendar is occupied; this is not a simulation of human attention, meeting attendance or tool execution time.

## Grading and benchmark limits

The twelve criteria are four narrow automatic checks and eight content-review criteria. Each new workstream has its own review row: scheduling, authorised sharing, event organisation and Attio accuracy. The existing four review rows cover briefing accuracy, the customer reference, triage/handoff and the late correction. This keeps a dropped event or stale CRM distinct from a wrong investment memo.

Attio does not yet have deterministic content checkers in this harness. Its criteria go to the judge as explicit review questions. Do not present the delivery percentage as an overall task-success score or rank models from it. The reference evidence must include actual writes, recipients, meeting times, CRM note bodies and open tasks; truncated snapshots or missing activity must be called out as unmeasured. The default Attio snapshot truncates note excerpts, so full note reads and successful tool-write content matter for review.

The environment is a reusable pilot, not a validated reconstruction of a real fund or a prediction of investment returns. To make it publication-ready, obtain a practitioner's source packet and review; create a reference completion; verify grading against deliberately flawed completions; then freeze model, harness, tool, memory, world and judge configurations before repetitions and held-out cases.

Source fixture: `packages/world/src/templates/alderbridge-busy-day.json`. The offline authoring utility is `packages/world/scripts/build-vc-busy-template.ts`; it imports the existing baseline history and the busy variant's cast/calendar schedule, and writes only this fixture. No model call or running-app reset is part of generation.

## Verification

On 10 September 2026, 829 unit tests passed across the scenario, world, engine, platform and Attio workspaces. The modified workspaces passed typechecking. Attio's 46-check HTTP smoke suite passed against an isolated copy. The actual busy-day fixture was seeded into isolated Calendar and Attio servers: the agent tools found only the shared 15:00 slot, created the group invite, rejected unknown attendee availability, read the three deals and sharing notes, updated a stage and wrote a CRM note. An offline engine execution delivered all 24 scheduled events across 36 intervals. The saved dashboard scenario, Attio service selection and mobile review page were verified. These checks are not measurements of model performance; no paid model or judge run was launched.

The live checks exposed and fixed two prerequisites: colleague personal calendars now resolve by email for availability queries, and unavailable calendar data no longer returns apparent free time. Attio writes now follow the latest seeded attribute version even if the fictional day is ahead of the host clock. That CRM timestamp is an ordering floor, not simulated time; action audit timestamps and run ticks remain the evidence for deadlines. The pre-existing local Attio database also needed its committed schema applied; the additive initialisation restored its health endpoint.

Attio is available to the agent through the existing CRM API/tools and to people through the browser replica at http://localhost:3500. Open Attio from the platform to inspect the same companies, contacts, deal pipeline, permission notes and follow-up tasks. Browser edits use the existing API validation and versioned write path.
