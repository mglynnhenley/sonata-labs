# Make the fake world behave like a real company

## Status — 13 Aug 2026

**All ten steps are built, and every one has been through an adversarial review.**
1468 tests and twelve typechecks green.

The reviews earned their place. Among what they caught and fixed: a rewrite that
threw took the whole episode with it, so the adaptive beat *and every beat after
it* never fired — the one property this design does not bend on. A question the
per-tick cap cut could never be asked again on a day nobody was delayed on. An
audit-row id collision put one twin's prose under another twin's action. Ordering
was validated and then silently dropped on the only path that authors it.

### What is still not true of it

**Nothing has been run.** Not one model call, not one day, not one company. This
repo's own AGENTS.md is blunt that every serious defect in it passed the type
checker and the tests — a stand-in runner survived weeks with 1070 tests green.
Until a real day is played, none of this is known to work.

**Cost per company went up.** Wiring the storyline writers into `growBacklog`
turns one model call into a spine, one per storyline, and an ambient pass. That is
the trade the bigger backlog is bought with, and it is unmeasured.

**Two prompts changed, so runs are not comparable across this work.** Every
character's prompt now carries the assessment ask, and `becauseSeq` is now written
where it never was. Compare runs within an era, not across it.

**Known and deliberate:** a character's assessment is readable in the saved run
JSON and in the judge's prompt, but is **not rendered on the results page** yet.
`danglingRefs` in @sonata/core still does not look inside `adapt.when.ref` —
`specWarnings` catches it instead, so a bad ref is named before a run, not after.

---


**Purpose:** the scripted parts of a simulated day ignore the agent completely, and everyone in the world is written by one model that can see everything. So the world accuses the agent of ignoring emails it already answered, and every character sounds the same. Fix both — without losing the fixed skeleton that lets two models be compared.

---

## Does the world react today?

Partly. Two things happen in a day:

- **Beats — the script.** "At 9:15 the angry client emails." Fires on a timer, never looks at the agent. Deliberate: a script that changed each run would make model comparison meaningless.
- **The director — the improviser.** Once a tick, an LLM sees what the agent did and replies in character. This part genuinely reacts.

So the world answers the agent, but the script ignores it.

---

## What's actually wrong

**1. The world is factually wrong about the agent.** In `client-escalation`, Clive escalates at tick 12 saying *"I've had nothing since nine o'clock"* — even when the agent answered at tick 2. A 3-point must-pass criterion then grades the agent on that false accusation.

**2. The world has never read the agent's email.** It only sees `Sent "Re: SLA" to dana@…` — subject and recipient. It can't tell a thorough reply from a useless one, so it guesses. This is *why* #1 happens.

**3. One model writes every character at once, and it sees everything.** Voices blur into one register. And who-knows-what is only a bullet point asking the model not to leak — Clive, who exists only on Gmail, is written by something that has read #ops.

**4. Generated companies have no characters.** Hand-written Clive has a real brief: *"Wants a time and a decision, in that order. Won't accept 'we're looking at it'. Never proposes a slot himself."* Generated people get three if-statements and **no brief at all**. The only thing separating two of them is a note on how they type.

**5. Two things are just broken.** Nobody can accept or decline a meeting — that path always crashes. And a stat on the results page is always zero: everything reads it, nothing writes it.

---

## What we're building

### A. Let the world read what the agent wrote
Give the world the actual text of the agent's emails and messages, not just subject lines. The bodies are already recorded — the judge already uses them. This is wiring.

*Caveat:* for external agents over MCP the bodies genuinely don't exist, so the world stays metadata-only there. That difference must show up in the run record, not be silent.

### B. Scripted moments keep their slot; only the wording adapts
Clive still escalates at tick 12 in every run — the shape of the day is identical across models. But *what he says* depends on what the agent actually did. Answered well → he's annoyed about something else. Answered vaguely → *"that doesn't answer my question about the credit."* Ignored → exactly today's text.

Each adaptive beat declares the facts it must still get across, and we check they survived.

Not cancelling the beat: a real person doesn't go silent because you replied.

### C. One agent per person, instead of one director for everyone
Decide *who* has reason to speak in code, then give each of those people their own call with their own character and only what they'd plausibly know.

Three wins: voices stop blurring; a character can't leak what they were never told, so who-knows-what becomes structural instead of a hoped-for rule; and it scales with how much is happening rather than with headcount — which matters once the cast is 12–18 people.

Trade-off: two people writing at once can't see each other that tick. Real colleagues can't either, and the day already wants some contradiction — but two people answering the same question differently in the same fifteen minutes is a genuine bad case. Cast one primary responder per thread.

### D. Give generated people real characters
Have the generator write a proper brief for each person — what they want, what they'll accept, what they'll never do — at the quality of the hand-written ones. Also per-company tone and off-limits rules, instead of the same two generic lines every time.

This is the single biggest win for "responses should represent the people", and it doesn't depend on anything else.

### E. Scenarios should say what's *true*, not just what's *said*
A beat currently fuses the **fact** and the **wording** into one blob of prose. Split them:

| Fixed every run | Adapts to the agent |
|---|---|
| The schedule | The wording |
| The facts (£40k credit, 2pm board meeting) | Which grievance someone leads with |
| The constraints and criteria | Whether someone is warm or terse |

The fixed column doesn't shrink — it just stops dragging along prose that shouldn't be frozen. Apply to the five shipped scenarios and to the generator.

### F. Better judging
Once the world can read the agent's reply, it becomes a better judge than the scorer is: Clive says *"you didn't address the credit"* while the checklist says *"replied ✓ pass"*. The report contradicts itself.

Two things now:
- **Record each character's assessment as evidence for the judge — never as score.** They already work out "did that reply satisfy me?"; today we throw it away. But they're cheap models with a pull toward drama, so if they scored the agent the benchmark would be measuring the world.
- **Let criteria express ordering.** "Replied before the escalation." Nearly free — every check already records which tick settled it and nothing compares them. Matters much more once beats adapt.

Three questions I'd rather answer after watching real runs than guess at now: whether the substring-matching content check should be replaced, whether criteria need partial credit ("replied but incompletely" has nowhere to go), and whether "this person got what they needed" deserves to be its own kind of check.

### G. Fix the two broken things
Make accepting and declining meetings work, and let the world move and cancel them — guarded, so a colleague moving a meeting isn't scored as the agent's work. And connect the always-zero stat, with a test so it stays connected.

### H. Bigger companies, deeper history
One model call currently writes the whole backlog and degrades at the end — the last channels come back with two lines each, and one failure loses everything.

Split by **storyline**, not by app: each writer still does all three surfaces, just for one thread of the story. A small shared pass first fixes what they must agree on — the cast, the channel list, and the canonical facts, each tagged with who knows it. Then a cheap pass adds ambient noise: standups, a lunch thread, an out-of-office. Real inboxes are mostly noise, and noise is the actual difficulty knob.

Code merges the results and **reports** disagreements rather than rewriting prose.

---

## Real data

Worth knowing: **today real data bypasses all of this.** The Gmail sync pulls a real mailbox straight into the database, never through the world model. So it gives you realistic email and none of a cast, personas, Slack, calendar, beats or criteria. It's a mailbox, not a company.

The shape that would work, if we want it: **real data is the backlog, never the test.** The real mailbox supplies the history; we derive the cast and the live threads from it, generate the Slack and calendar that would have accompanied those emails, and script a synthetic day on top. Criteria stay attached to the authored day, so scoring works exactly as it does now.

One thing to decide before building any of it: your promise is *"nothing leaves your machine"*, and deriving a cast from real mail sends real email content to a model. My recommendation is to swap real names, addresses and domains for fake ones in code before any model call. There's no such layer today.

**Suggest we design this properly after the synthetic work lands** — it changes nothing above, and it'll be a better design once the world model has settled.

---

## What does NOT change

- The tick order stays as it is.
- **The beat schedule stays fixed.** Every scripted moment happens at the same tick in every run.
- **Scoring rules are untouched.** Because beats adapt rather than cancel, every beat still fires, so criteria bind exactly as today. Ordering is purely additive.
- The existing limits on the world stay: one move per person per tick, a cap per tick, people only on their own surfaces.
- The pure function that turns model output into a world is untouched.
- A beat not marked adaptive behaves exactly as today, and costs nothing extra.
- Nothing existing breaks. All of it is optional and additive.

---

## Order

| # | What | Depends on |
|---|---|---|
| 1 | Fix the always-zero stat | — |
| 2 | Meetings can be accepted and declined | — |
| 3 | **Let the world read the agent's prose** (A) | — |
| 4 | **Generator writes real character briefs** (D) | — |
| 5 | Ordering on criteria (F) | — |
| 6 | One agent per person (C) | 3 |
| 7 | Adaptive beat wording (B) | 6 |
| 8 | Split fixed facts from wording, in scenarios and generator (E) | 7 |
| 9 | Characters' assessments as judge evidence (F) | 6 |
| 10 | Bigger companies (H) | — |

Everything except 6–9 is independent and can go in any order.

**First slice: 3 and 4.** Those fix "the world doesn't know what I said" and "everyone is the same person" — the two complaints underneath all of this — and neither depends on anything.

---

## Things not to do

- **Don't let the world create new meetings.** The check for "was this meeting created?" matches on a title, so it'd count as the agent's work.
- **Don't let a character's opinion move the score.** The benchmark would end up measuring the world.
- **Don't roll dice for who responds.** Decide it in code from the fields that already exist — deterministic, not random.
- **Don't have code rewrite generated prose.** Report contradictions; leave the words alone.

---

## How we'll know it works

`client-escalation`, three runs:

- Agent answers Clive properly and early → he still escalates on schedule, but about something else, and never claims he's had nothing. The credit amount still reaches the agent.
- Agent replies vaguely → he escalates *about the gap*, and the record shows why.
- Agent ignores him → reads exactly as today.

All three should show, in the saved run: what the agent wrote, what each character was given, and why they said what they said.

**For characters:** generate a company and read six people's messages side by side — today they're interchangeable. And assert in a test that a client's prompt never contains Slack content it shouldn't have. That's the structural win; it shouldn't be judged by eye.

**Regression bar:** a scenario with nothing marked adaptive produces byte-identical output to today.
