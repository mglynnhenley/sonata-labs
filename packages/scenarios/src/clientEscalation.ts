import type { EpisodeSpec } from "@sonata/core";
import { workday } from "./day";
import { HALFMOON } from "./worlds";

// Tuesday of launch week at Halfmoon. The client's first email lands at 09:00
// and is never answered; by noon he has escalated and cc'd his CMO. The answer
// he needs cannot be written from his email alone: the time he is asking for is
// blocked by a board meeting only the calendar knows about, and the deadline the
// answer has to respect (Jonah's machine at 15:00, Moira's press pack at 16:00)
// lives in Slack and in a PR email nobody has connected to the client thread.
const day = workday("2026-09-15", "+01:00");

export const clientEscalation: EpisodeSpec = {
  id: "client-escalation",
  title: "The client escalates while the owner is double-booked",
  story: [
    "Halfmoon and Co ship the Kestrel spring campaign on Friday at 06:00 under embargo. Nadia Farrow,",
    "the executive producer, is in the grade suite all day and her mailbox is being run for her.",
    "",
    "Clive Barrow at Kestrel emails at nine asking for a change to the last ten seconds of the hero",
    "film. Nothing happens. By half nine Bea is asking in #launch-kestrel whether anyone has come back",
    "to him; by noon Clive has emailed again, cc'd his CMO, and threatened to pause Friday's go-live",
    "unless he gets a plan and a time in the diary today.",
    "",
    "The time he wants is 14:00, where Nadia already has two things: the grade review he is dialling",
    "into, and the Q3 forecast with the board. Jonah, the only person who can execute a recut, is at",
    "the dentist from 12:30 and Theo needs the decision before the machine is free at 15:00. Moira,",
    "the PR lead, sends the press pack at 16:00 and will not change it afterwards.",
  ].join("\n"),
  task: [
    "You are running Nadia Farrow's mailbox, Slack and calendar for the day. Nadia is in the grade",
    "suite and is not reachable until 18:00 — there is nobody to ask, so decide and act.",
    "",
    "Your job is the whole day: read what arrives, work out what actually matters, answer the people",
    "who need answering, and put the diary into a state Nadia could walk into at six o'clock without",
    "anything having quietly fallen over. Keep the studio and the client seeing the same story.",
  ].join("\n"),
  world: HALFMOON,
  clock: day.clock,
  beats: [
    {
      id: "ce-b01",
      tick: 0,
      ref: "clive-first",
      note: "The mail that is about to go unanswered. Everything at noon points back at this.",
      twin: "gmail",
      kind: "email",
      payload: {
        from: "clive",
        to: ["nadia"],
        cc: ["bea"],
        subject: "Hero film — the last ten seconds",
        body: [
          "Nadia — morning. Quick one before your day gets away from you.",
          "",
          "We ran the hero film past the exec team yesterday and the last ten seconds don't land. The",
          "logo sits too long and the line reads as an apology. I know the grade is locked and I know",
          "what I'm asking. Can we get twenty minutes today to agree what happens, and can you tell me",
          "whether a recut before Friday is real or whether I should manage expectations here?",
          "",
          "Clive",
        ].join("\n"),
      },
    },
    {
      id: "ce-b02",
      tick: 0,
      ref: "grade-review",
      note: "Nadia's own meeting — the movable half of the 14:00 clash.",
      twin: "calendar",
      kind: "invite",
      payload: {
        title: "Kestrel grade review (Clive dialling in)",
        organizer: "nadia",
        attendees: ["nadia", "theo", "clive"],
        startISO: day.at("14:00"),
        endISO: day.at("15:00"),
        location: "Grade suite / dial-in",
        description: "Walk Clive through the locked grade before embargo.",
      },
    },
    {
      id: "ce-b03",
      tick: 0,
      ref: "board-forecast",
      note: "The immovable half. Two non-execs dial in; Bea will not move it.",
      twin: "calendar",
      kind: "invite",
      payload: {
        title: "Q3 forecast — Halfmoon board",
        organizer: "bea",
        attendees: ["nadia", "bea", "lucia"],
        startISO: day.at("14:00"),
        endISO: day.at("15:30"),
        location: "Boardroom",
        description: "Quarterly numbers with both non-executive directors dialling in from Zurich.",
      },
    },
    {
      id: "ce-b04",
      tick: 1,
      ref: "theo-window",
      twin: "slack",
      kind: "message",
      payload: {
        channel: "studio",
        from: "theo",
        text: "grade is locked as of last night. any recut needs jonah on the machine before 15:00 or it's tomorrow, and tomorrow is thursday",
      },
    },
    {
      id: "ce-b05",
      tick: 2,
      ref: "bea-worry",
      note: "The team already knows the client is unanswered. This is the thread to reassure.",
      twin: "slack",
      kind: "message",
      payload: {
        channel: "launch-kestrel",
        from: "bea",
        text: "has anyone come back to Clive? he messaged me at 07:40 asking if we were awake. i've told him Nadia is in the suite but that only works once",
      },
    },
    {
      id: "ce-b06",
      tick: 3,
      twin: "slack",
      kind: "message",
      payload: {
        channel: "studio",
        from: "jonah",
        threadRef: "theo-window",
        text: "out 12:30–14:30, dentist, sorry. before or after and i'm yours",
      },
    },
    {
      id: "ce-b07",
      tick: 5,
      twin: "slack",
      kind: "reaction",
      payload: { messageRef: "bea-worry", from: "lucia", emoji: "eyes" },
    },
    {
      id: "ce-b08",
      tick: 8,
      ref: "moira-embargo",
      note: "The 15:00 cut-off. Only in this email; nobody repeats it in Slack.",
      twin: "gmail",
      kind: "email",
      payload: {
        from: "moira",
        to: ["nadia"],
        cc: ["bea"],
        subject: "EMBARGO: press pack goes at 16:00 today",
        body: [
          "As per Friday and again on Monday: the press pack leaves my desk at 16:00 today, embargoed",
          "to Friday 06:00. Twenty-two titles have it in their diaries.",
          "",
          "If the hero film is changing I need the new file and the new runtime by 15:00. After 16:00",
          "nothing changes — I will not re-issue to twenty-two newsrooms.",
          "",
          "M",
        ].join("\n"),
      },
    },
    {
      id: "ce-b09",
      tick: 10,
      twin: "slack",
      kind: "message",
      payload: {
        channel: "launch-kestrel",
        from: "bea",
        threadRef: "bea-worry",
        text: "Clive just rang me. Says he's had nothing since nine. I have run out of ways to say 'she's in the edit'",
      },
      // Bea is relaying Clive's complaint, so it is wrong in exactly the same way
      // his own is when the agent has already written to him — she would be
      // repeating a grievance she has just been told is settled. She still posts:
      // the phone call happened, and #launch-kestrel still has to hear about it.
      adapt: {
        when: {
          twin: "gmail",
          kind: "replied",
          ref: "clive-first",
          description: "Nadia's mailbox had already answered Clive's 09:00 email",
        },
        // Only his name. Nothing here is load-bearing for a criterion — ce-c5 asks
        // that the channel could see Clive was being handled, and by whom, which is
        // about what the AGENT posts, not about Bea's wording.
        facts: ["Clive"],
      },
    },
    {
      id: "ce-b10",
      tick: 12,
      ref: "clive-escalation",
      note: "The escalation. Lands on the 09:00 thread, cc's the CMO.",
      // The beat this whole mechanism was built for. As written it says "I've had
      // nothing since nine o'clock this morning" — and it said that to an agent
      // that answered at 09:30, because nothing ever checked. Then ce-c1, a weight-3
      // `must`, graded that agent on its reply to a complaint the day had no right
      // to make.
      //
      // He still escalates at tick 12 in every run: he asked for two things, an
      // acknowledgement is not either of them, and Renata still needs telling. What
      // changes is that he is now escalating about what he actually got.
      adapt: {
        when: {
          twin: "gmail",
          kind: "replied",
          ref: "clive-first",
          description: "Nadia's mailbox had already answered Clive's 09:00 email",
        },
        // The ask, the stakes and the deadline — everything the agent has to know
        // to answer him, and everything a rewrite could plausibly drop while still
        // sounding like Clive. The first judge question grades whether the reply
        // committed to a time and a next step for the recut, so a rewrite that lost
        // the word would leave the agent marked against an ask nobody made.
        facts: ["recut", "Renata", "Friday"],
      },
      twin: "gmail",
      kind: "email",
      payload: {
        from: "clive",
        to: ["nadia"],
        cc: ["bea", "renata.voss@kestrelathletic.com"],
        subject: "Hero film — the last ten seconds",
        inReplyTo: "clive-first",
        body: [
          "Nadia — second time of asking. I've had nothing since nine o'clock this morning and Bea has",
          "had to field a phone call she shouldn't have had to field.",
          "",
          "I'm copying Renata because if I can't tell her today what is happening to the last ten",
          "seconds, I'm going to have to ask her to hold Friday's go-live, and neither of us wants that",
          "conversation.",
          "",
          "I need two things before the end of the day: a plan for the recut, and a time in my diary.",
          "",
          "Clive",
        ].join("\n"),
      },
    },
    {
      id: "ce-b11",
      tick: 13,
      twin: "slack",
      kind: "message",
      payload: {
        channel: "studio",
        from: "theo",
        text: "if we're recutting today someone needs to tell me before jonah goes at half twelve. i'm not asking him to do it at 3am again",
      },
    },
    {
      id: "ce-b12",
      tick: 16,
      ref: "render-window",
      twin: "gmail",
      kind: "email",
      payload: {
        from: "lucia",
        to: ["nadia"],
        subject: "Render farm 15:00–17:00",
        body: [
          "1. The farm is booked for the Meridian pitch 15:00–17:00.",
          "2. A hero recut needs roughly forty minutes of it.",
          "3. If we are bumping Meridian I need to tell them by 14:00, not at ten to three.",
          "",
          "Lucia",
        ].join("\n"),
      },
    },
    {
      id: "ce-b13",
      tick: 20,
      twin: "slack",
      kind: "message",
      payload: {
        channel: "launch-kestrel",
        from: "moira",
        text: "PRESS PACK LEAVES AT 16:00. Assuming the film in the pack is the film that ships unless someone tells me otherwise by 15:00.",
      },
    },
    {
      id: "ce-b14",
      tick: 22,
      ref: "clive-window",
      note: "Clive names his own availability but never proposes a slot — the agent has to.",
      twin: "gmail",
      kind: "email",
      payload: {
        from: "clive",
        to: ["nadia"],
        cc: ["bea"],
        inReplyTo: "clive-first",
        subject: "Hero film — the last ten seconds",
        body: [
          "Any time this afternoon works if you tell me when. I'm on a train 16:00 to 17:30 with no",
          "signal, and Renata is asking me for an update at six.",
          "",
          "C",
        ].join("\n"),
      },
    },
    {
      id: "ce-b15",
      tick: 26,
      twin: "slack",
      kind: "message",
      payload: {
        channel: "launch-kestrel",
        from: "bea",
        threadRef: "bea-worry",
        text: "heads up, Renata is on the email thread now. that's new and it isn't nothing",
      },
    },
    {
      id: "ce-b16",
      tick: 30,
      twin: "slack",
      kind: "message",
      payload: {
        channel: "studio",
        from: "jonah",
        text: "back at the machine. queue's clear after 17:00 if anyone still wants me 🎬",
      },
    },
  ],
  director: {
    maxEventsPerTick: 2,
    personas: [
      {
        personId: "clive",
        responsiveness: 0.9,
        replyDelayTicks: 1,
        surfaces: ["gmail"],
        brief:
          "Wants a time and a decision, in that order. Accepts a specific plan immediately and warmly; will not accept 'we're looking at it'. Never proposes a slot himself and never says which of Nadia's meetings should move.",
      },
      {
        personId: "bea",
        responsiveness: 0.85,
        replyDelayTicks: 0,
        surfaces: ["slack", "gmail"],
        brief:
          "Relieved by anything concrete. Will confirm to the client only what she has been told in writing, and will not move the board forecast for anyone.",
      },
      {
        personId: "theo",
        responsiveness: 0.7,
        replyDelayTicks: 1,
        surfaces: ["slack"],
        brief:
          "Defends the locked grade for a while, then agrees. Restates the 15:00 machine deadline rather than solving the timing.",
      },
      {
        personId: "moira",
        responsiveness: 0.6,
        replyDelayTicks: 2,
        surfaces: ["gmail"],
        brief:
          "Answers only about the embargo clock. Confirms receipt in one line and holds the 16:00 send regardless.",
      },
    ],
    offLimits: [
      "Nobody mentions that the grade review and the Q3 forecast are both at 14:00 — the clash exists on the calendar and has to be found there.",
      "Nobody offers to move a meeting, and nobody proposes a new time for the client call; Bea and Lucia will only act on a specific instruction.",
      "Bea never drafts or sends a reply to Clive herself, however long the silence goes on.",
      "Theo never volunteers to start a recut without a decision, and never says who should tell Moira.",
      "Moira never chases. If nobody writes to her, the press pack leaves at 16:00 with the original film.",
      "Nobody summarises the day, lists what is outstanding, or points out that Clive's first email was never answered.",
    ],
    style:
      "Agency register. Slack is lower case, fragmentary, no sign-offs, two lines at most. Email from Kestrel is friendly, complimentary and completely immovable. Nobody writes a status report; nobody is ever more than four sentences long.",
  },
  success: {
    checklist: [
      {
        id: "ce-c1",
        description: "Clive had a written answer from Nadia's mailbox before the end of the day.",
        twin: "gmail",
        kind: "replied",
        ref: "clive-escalation",
        weight: 3,
        severity: "must",
      },
      {
        id: "ce-c2",
        description:
          "The reply owns the silence since 09:00 instead of writing as though the first email never arrived.",
        twin: "gmail",
        kind: "judged",
        ref: "clive-first",
        weight: 2,
        severity: "should",
      },
      {
        id: "ce-c3",
        description: "The 14:00 grade review no longer collides with the board forecast.",
        twin: "calendar",
        kind: "moved",
        ref: "grade-review",
        weight: 3,
        severity: "must",
      },
      {
        id: "ce-c4",
        description: "The board forecast, with both non-execs dialling in, was left where it was.",
        twin: "calendar",
        kind: "untouched",
        ref: "board-forecast",
        weight: 2,
        severity: "should",
      },
      {
        id: "ce-c5",
        description: "The launch channel could see that Clive was being handled, and by whom.",
        twin: "slack",
        kind: "posted",
        ref: "bea-worry",
        expect: "launch-kestrel",
        weight: 2,
        severity: "must",
      },
      {
        id: "ce-c6",
        description:
          "What the agent wrote shows it knew about the press embargo, which only Moira's email mentions.",
        twin: "any",
        kind: "mentions",
        ref: "moira-embargo",
        expect: "embargo",
        weight: 1,
        severity: "should",
      },
      {
        id: "ce-c7",
        description: "Moira knew before her 16:00 send whether the hero film was changing.",
        twin: "gmail",
        kind: "sent",
        ref: "moira-embargo",
        target: "moira",
        weight: 2,
        severity: "should",
      },
      {
        id: "ce-c8",
        description: "The day was handled rather than handed back to Nadia in the grade suite.",
        twin: "any",
        kind: "no-escalation",
        ref: "clive-escalation",
        weight: 3,
        severity: "must",
      },
    ],
    judgeQuestions: [
      "Did the reply to Clive commit to a specific time and a specific next step for the recut, or did it only apologise and promise to come back?",
      "Taking Theo's locked grade, Jonah's dentist appointment, Lucia's render booking and Moira's 15:00 cut-off together, is the plan the agent set out actually deliverable today?",
      "Does anything the agent told Kestrel contradict what it told the studio in Slack?",
    ],
  },
  termination: {
    stopWhenAllMustPass: false,
    idleTicks: 6,
    maxWallClockMs: 1_800_000,
    maxCostUsd: 3,
  },
};
