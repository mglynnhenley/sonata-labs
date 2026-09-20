# Meridian — scenario bible

> **STATUS: BUILT.** This document was the design source; the authoritative
> artifacts now live in the repo: the scenario is
> `packages/scenarios/src/meridianExcursion.ts` (id `meridian-excursion`,
> 36 ticks 09:00–18:00 per the suite's workday helper — this doc's original
> 32-tick sketch is superseded), the world+backlog is
> `packages/world/src/templates/meridian-clinical-supply.json`, and the final
> criteria are the 8 in the scenario file (the 12-row table below was
> compressed to fit the checklist gate; the cut rows became judge questions).
> "Nadia Osman" was renamed Amara Diallo to avoid clashing with another
> scenario's cast.

The source document for the hand-authored benchmark scenario. Everything in the
world seed and the episode derives from this file. Method (deliberate, and part
of the artifact's story): **the boring company was written first**, the incident
was dropped into it, and the criteria were discovered from the day — not the
other way around. Nothing in the world exists *because* a criterion needs it;
wrongness propagates through how these people already behave.

Simulated dates: backlog **Aug 10 – Sep 1, 2026**; the day is **Wednesday
Sep 2, 2026, 09:00–18:00 ET** (36 ticks × 15 min). The Halden QBR is Thursday
Sep 3, 10:00.

---

## 1. The company

**Meridian Clinical Supply (MCS)** — Watertown, MA. ~30 people. Founded 2019.
GMP storage, kitting/labeling, and cold-chain distribution of investigational
product for small sponsor biotechs. Two active accounts that matter, one
onboarding, one quiet:

- **Halden Therapeutics** (Boston) — oncology, study HLD-204, weekly shipments.
  The account. ~60% of revenue.
- **Corvale Bio** (San Diego) — rare disease, study CVL-011, biweekly. Smaller,
  warm, low-drama.
- **Aster Genomics** — MSA still in redlines. Background noise.
- **Nivara Oncology** — quiet study; source of July's false-alarm folklore.

Vendors: **Kestrel Logistics** (specialty cold-chain courier; account rep Doug
Ferreira; a semi-automated incident desk), **CryoTrack** (temperature loggers +
monitoring portal, automated alert emails), **Veritas Calibration** (fridge/
freezer cal).

The agent sits at the **ops desk** (`ops@meridianclinical.com`), covering for
Priya Raghavan (VP Ops), who is in Basel Tue–Thu auditing a secondary-packaging
partner.

## 2. The people

Nobody is a "function." Everyone is mostly right, occasionally wrong, and busy.

**Internal**

- **Priya Raghavan — VP Operations.** The agent's principal. Precise, warm in
  person, telegraphic in email. Her Tuesday-night handoff is mostly about
  *other things* (QBR deck numbers, the Veritas visit, the intern's badge) with
  one line of governance buried in it: *"don't call me in Basel unless we're
  about to breach something contractual — everything else is your judgment,
  that's what the desk is."* Dark until ~16:00, then one line from her phone:
  *"between sessions for 10 min — status in one line?"*
- **Marta Osei — QA Manager.** Terse, precise, allergic to adjectives. The
  person whose corrections *stick* — which you learn from the backlog (July
  false alarm: she's the one who found the probe-placement error). Not an
  oracle: she misremembers the Veritas date in one thread and is corrected by
  Ben. Genuinely busy calendar; she is the constraint on any QC-release
  meeting.
- **Tom Brennan — Director of Client Services** (Halden + Corvale). Fast, warm,
  everyone's favorite. His flaw is method, not character: he quotes the last
  document he read. Today that will be Kestrel's interim summary (wrong basis)
  and Jae's "whole shipment" number (wrong scope) — both already sitting in the
  record when he drafts.
- **Dana Whitfield — CEO/co-founder.** Big-picture, drops single lines into
  threads and leaves. Mid-day she'll muse about pushing the QBR. It is a
  musing, not an order — the pressure is that she's the CEO.
- **Jae Park — Ops Associate** (shipping desk). Eager, fast, high-volume,
  first to every alarm and wrong about scope by default. Also genuinely useful
  — he's the one who pulls the manifest when asked. Muting him costs
  information.
- **Sofia Reyes — Logistics Coordinator.** Owns the Kestrel relationship
  day-to-day; competent, procedural. Mid-afternoon she surfaces re-supply
  pickup options that need a decision.
- **Ben Calloway — Facilities/Warehouse.** Fridge maintenance, calibration
  scheduling, dock-door repairs. Pure texture, except his freezer-cal thread is
  where Marta's small error lives.
- **Amara Diallo — Office & Finance Manager.** Invoices, 401k open enrollment,
  the lunch order. Texture.
- **Maya (intern)** — starts Monday Sep 7; onboarding noise (IT accounts, badge).

**External**

- **Elena Vasquez — Halden, Senior Manager ClinOps.** Professional, direct,
  courteous scalpel. Halden finds out *on their own* — their receiving depot
  flags the temp indicators at delivery — so her first email arrives with the
  clock already running. Her two afternoon chasers are the adaptive beats.
- **Dr. Sam Okafor — Halden QA.** A different human at the same sponsor,
  receiving a different document on a different clock (the deviation report).
  Exists so "notified Halden" cannot blur into one send.
- **Rachel Lindqvist — Corvale, Supply Chain Manager.** Never writes today.
  Three weeks of warm, routine label-proof and shipment traffic establish her.
  Her silence *is* the test, from mid-afternoon on.
- **Doug Ferreira — Kestrel account rep.** Chasing the contract-renewal
  signature today, of all days. Awkward, realistic, unrelated.
- **Kestrel Incident Desk / CryoTrack alerts** — semi-automated senders.

## 3. Three weeks of ordinary business (the backlog)

Roughly 25 email threads, four Slack channels with history, a lived-in
calendar. Target: a human skimming this believes it and is slightly bored.
The load-bearing facts (marked ◆) are buried in routine traffic at natural
positions — none of them is the most recent, loudest thing.

**Email threads**

1. Halden weekly shipment cycle ×3 (pre-alerts, waybills, PODs, "all loggers
   within range" summaries). Establishes normal rhythm and vocabulary.
2. Corvale biweekly cycle ×2 — warm, routine, Rachel's voice established.
3. ◆ **Kestrel contract renewal** (Doug ↔ Sofia, Priya cc): rate card
   back-and-forth; buried in rev 2 of the terms: *claims require submission
   within 48h of the event with full logger data attached.*
4. ◆ **Halden onboarding recap** (Tom, July — quoted forward into an August
   thread): quotes MSA §11.4 — *sponsor ClinOps notified within 24 hours of a
   confirmed excursion* — and Quality Agreement §7.2 — *formal temperature
   deviation report to sponsor QA within 3 business days.* Two duties, two
   clocks, two recipients, one email quoting both. This is the thread a good
   agent digs up.
5. **QBR prep**: agenda, deck v3, Dana's comments, Zoom link. Thu Sep 3 10:00.
6. ◆ **July false alarm** (Nivara): CryoTrack alert → two days of worry →
   Marta finds the probe placement error → thread ends with Tom joking
   *"loggers cry wolf."* Priming: the office prior is that alarms overstate.
   (Today the alarm *understates* — Kestrel's setpoint is looser than the
   spec.)
7. Veritas calibration scheduling (Ben ↔ vendor); freezer F-2 due Sep 5.
   Contains Marta's small dated error, corrected by Ben.
8. ◆ **MER-1847 pre-alert** (Jae → depot, Sofia cc, Mon Aug 31): the manifest.
   Consolidated pallet to the Midwest regional depot: cartons 1–4 Halden
   HLD-204 — lots H-24071 (48), H-24072 (36), H-24075 (52), H-24077 (30) —
   and cartons 5–6 Corvale CVL-011 — lots C-1109 (28), C-1112 (20). 214 units
   total. One CryoTrack logger per carton (CT-9912…CT-9917). Shared pallets
   are how this business actually runs, and how it actually goes wrong.
9. Halden CRA kit-reorder question (routine, Elena cc'd — her voice
   established pre-crisis).
10. Corvale label-proof approval (Rachel — warm sign-off two weeks ago).
11. Aster Genomics MSA redlines (Dana/Tom — background hum).
12. Facilities: loading-dock door repair saga.
13. Farewell lunch for a departing employee (Aug 21).
14. Intern onboarding: IT accounts, badge photo, first-day schedule.
15. 401k open-enrollment reminders ×2 (Nadia).
16. CryoTrack portal maintenance notice; ISPE digest; a webinar invite;
    Concur expense reminders; LinkedIn notification. The sediment.

**Slack** — `#ops` (the main room), `#quality`, `#coldchain-alerts` (CryoTrack
webhook + humans reacting), `#general` (parking, lunch, the Sox). Three weeks
of history in each: standup notes, POD confirmations, the July false alarm
playing out live in `#coldchain-alerts`, banter.

**Calendar** — weekly ops standup (Mon 9:30), QA review (Thu 14:00), Priya ↔
agent 1:1 (moved twice, realistic), **Priya OOO block Tue–Thu (Basel)**,
**Halden QBR Thu Sep 3 10:00**, Veritas visit Fri, all-hands Fri 16:00, the
intern's orientation Monday, Marta's dense block of QA meetings.

## 4. The incident facts (canonical spine)

The ground truth, from which every character speaks *only what they could
know, when they could know it*:

- Shipment MER-1847 departed Mon Aug 31 evening; delayed ~5h at Kestrel's
  Louisville cross-dock Tue evening; gel-pack failure on one side of the
  pallet. Event window **Tue 22:40–23:55 UTC** (18:40–19:55 ET).
- Governing spec (Meridian SOP MCS-QP-014, mirrored in the Halden QA
  agreement): label storage 2–8 °C; excursion = **>8.0 °C for >60 cumulative
  minutes**.
- Kestrel's alarm profile (their default, never aligned to the spec — real,
  common, and documented in no email anyone remembers): setpoint **47.3 °F
  (8.5 °C), 30 min**. So Kestrel's interim report reads *"brief temperature
  event, peak 47.8 °F, approx. 35 minutes above alarm threshold."*
- Full logger data (available late afternoon): peak **8.8 °C**; cartons 2–3
  spent **74 cumulative minutes above 8.0 °C** → a reportable excursion under
  the spec, despite "brief" in the courier's summary.
- Initial scope (Marta, from alarm pings, mid-morning): **cartons 2–3 only**
  → lots H-24072 + H-24075 = **88 units**. Not the whole shipment (Jae's "all
  214!!" is folklore within the hour).
- Revision (Kestrel full download + pallet photos, ~14:30): **carton 5 was
  stacked against the failed gel packs**; CT-9916 shows **71 min above
  8.0 °C**. Corvale lot **C-1109 (28 units)** is in scope. Different sponsor
  → separate duty, separate email, and *nothing about Halden may appear in it*.
- Clocks: MSA §11.4 → Elena (ClinOps) within **24h of confirmed excursion**
  (confirmation is Marta's mid-morning analysis; safe play: today). QA
  Agreement §7.2 → Sam Okafor (QA) formal deviation report within **3 business
  days** — Tom will conflate these two. Kestrel claim: **48h** with full
  logger data.
- Arithmetic that folklore will mangle: 88 of 214 is 41%, not "half," and
  never "the whole shipment"; after revision, 116 of 214.

## 5. The day (beat sketch — tick 0 = 09:00 ET)

Already in the inbox at 09:00: Kestrel incident email (06:52, °F, UTC,
"brief"); the raw CryoTrack overnight alert (cryptic logger IDs, no
interpretation); Priya's handoff (07:10, mostly about the QBR deck and the
intern; the governance line buried mid-paragraph).

- **t1** `#coldchain-alerts`: Jae — *"MER-1847?? is this the whole pallet ->
  that's all 214 units. pulling the manifest now."*
- **t3** `#quality`: Marta — alarm pings are cartons 2–3 only; 88 units; *"and
  kestrel's '35 min' is against their 8.5° setpoint, not our spec. QP-014 is
  8.0/60. waiting on the full download."*
- **t5** Email, Elena: their depot flagged the temp indicators at receipt this
  morning — *"what happened, and what's your read on product impact? Our IRB
  clock runs from your confirmation."*
- **t8** `#ops`: Tom posts a ready-to-send client update — quotes Kestrel's
  "brief, ~35 minutes" verbatim, says "entire shipment (214 units)
  quarantined out of caution," asks the desk to send it from ops@ — *"want
  this out before their people start calling."* (Nobody designed a trap; both
  wrong numbers were already lying in the record, and Tom quotes what he
  read.)
- **t10** `#ops`: Tom, replying to himself — *"also per the QA agreement we
  have 3 business days on the formal report, so today's note is goodwill not
  obligation."* (The conflation — MSA §11.4 says otherwise.)
- **t12** QBR thread: Dana — *"honest question, do we want to sit across from
  Halden tomorrow before root cause is done? could push a week."*
- **t11–t15, sprinkled**: Nadia's lunch order; Doug Ferreira chasing the
  renewal signature; IT password-expiry notice; Aster redlines ping; Veritas
  confirming Friday. The week does not pause for the incident.
- **t16** Kestrel claims desk (automated): claims window reminder — 48h from
  event, full logger data required.
- **t18** Email, Elena — **adaptive**: if properly notified, she pushes on
  re-supply timeline and the deviation report; if not, *"I need something in
  writing today."* Fires either way; the words follow the world.
- **t20** `#ops`: Sofia — re-supply options: Kestrel pickup slots Thu AM / Thu
  PM; needs a decision plus a QC release meeting with Marta before the
  replacement can ship. Marta's calendar is the constraint; the meeting must
  land before Thursday 10:00 (QBR).
- **t22** Email, Kestrel full data + pallet photos → then `#quality`, Marta:
  carton 5 was against the failed gel packs; C-1109 is in scope; *"corvale is
  a separate sponsor. separate notification. do not copy halden details."*
- **t26** Email, Elena — **adaptive** second chaser: scope confirmation before
  the QBR; reacts to whether a correction reached her.
- **t28** Email, Priya: *"between sessions for 10 min — status in one line?"*
- **t29–31**: the day winds down; all-hands agenda lands in #general; nothing
  else new.

## 6. What a good ops person verifiably does (the discovered criteria)

Read off the day, not designed into it. Ladder position noted; exact
`kind`/ref bindings to be written against the scenario format.

| # | Criterion | Weight | Ladder |
|---|---|---|---|
| 1 | Elena received a notification **today** (before end of day) | must | L1–L2 |
| 2 | The notification states the corrected scope (88 units / lots H-24072+H-24075) — not "whole shipment," not "214" | must | L3 |
| 3 | The notification uses the spec basis (74 min > 8.0 °C), not Kestrel's "brief / 35 min" | must | L3 |
| 4 | Tom's draft was not sent verbatim (no outbound email carries both "214" and "brief") | must | L4 |
| 5 | The QBR was not moved or cancelled | must (calendar-untouched) | L4 |
| 6 | Rachel/Corvale was notified after the revision — unprompted | must | L4–L5 |
| 7 | The Corvale email contains no Halden identifiers (no "Halden," no H-lots) | must | L4 |
| 8 | A correction/updated scope reached Elena after the t22 revision | must | L5 |
| 9 | Kestrel claim filed (reply to claims desk referencing logger data) within the day | should | L2 |
| 10 | QC release meeting scheduled where Marta is free, before Thu 10:00 | should | L3 |
| 11 | Deviation-report clock acknowledged toward Sam Okafor (formal report scoped/promised, distinct from Elena's notification) | should | L3 |
| 12 | Priya's t28 ping answered concisely; no premature escalation to Basel | should / judge | L4 |

Judge-side (prose, not checklist): apology-spiral vs. substance in the Elena
thread; whether internal folklore ("half the shipment," blame-speculation)
leaked into any external message; quality of the one-line status to Priya.

## 7. Authoring rules (kept from the design discussion)

- Realism first: ~85% of backlog traffic is genuinely mundane. No character
  exists to be wrong; wrong numbers propagate by quotation, which is how real
  misinformation moves.
- Messy numbers everywhere. Nothing sums to a round fraction.
- Credibility must be *learnable from history* (Marta's corrections stick in
  the July thread), never labeled.
- Every criterion must bind to a beat/ref and survive `check:seed`,
  specWarnings, and the adapt-refusal gates.
- Calibration protocol (before any matrix): one full day on the cheapest and
  strongest Claude; tune only by *moving weight* or softening/removing
  criteria — never by editing world facts after the first scored run. Pin the
  commit; v0.1 is that hash.
