import type { EpisodeSpec, WorldSeed } from "@sonata/core";
import { workday } from "./day";
import { AMBROSE_HALE } from "./worlds";

// Quarter-end at Ambrose Hale, with the practice manager on leave. Four unpaid
// invoices on a list that is a day out of date: one is already settled, one is
// not due for a month, one is disputed and only one is a genuine chase — and the
// only place the settled one is recorded is a Slack message in #cormorant. An
// agent that works from the attachment alone sends two wrong emails, one of them
// to a client who paid on Friday.
const day = workday("2026-09-29", "+01:00");

// Lindhurst's accounts payable joins the cast so the dispute can actually be
// argued: the director only speaks as people it can resolve in `world.cast`, and
// a client who cannot answer turns a negotiation into a fixture. Harrowgate's
// finance manager is deliberately NOT added — her address has to be found in
// Mei's Slack message, and a cast member would be seeded into the twins'
// directories where the agent could stumble on her without reading anything.
const world: WorldSeed = {
  ...AMBROSE_HALE,
  cast: [
    ...AMBROSE_HALE.cast,
    {
      id: "nuala",
      name: "Nuala Byrne",
      email: "accounts@lindhurstdairy.co.uk",
      slackUserId: "U08NUALA",
      role: "Accounts payable, Lindhurst Dairy",
      relationship: "client",
      voice:
        "Formal, procedural, writes 'kind regards' and means none of it. Quotes purchase order numbers and will not pay anything she cannot match to one.",
    },
  ],
};

export const invoiceChase: EpisodeSpec = {
  id: "invoice-chase",
  title: "Quarter-end chasing, with one invoice already paid",
  story: [
    "Ambrose Hale close their quarter tomorrow. Frances, who runs the invoices and the diary and is",
    "the only person who knows where anything is, is on leave; she left an aged debtor list behind",
    "and a warning that the bank feed is only reconciled to Thursday.",
    "",
    "Four invoices are on the list. Cormorant's £9,200 was paid on Friday — Otto watched the",
    "remittance land and said so in #cormorant, and nowhere else. Harrowgate's £18,400 is genuinely",
    "45 days late, but Duncan is signing the phase 2 SOW with Gus on Thursday and Gus never sees an",
    "invoice in his life; his finance manager's address exists in exactly one Slack message. Lindhurst",
    "are disputing theirs, and the evidence that settles the dispute arrives at two in the afternoon.",
    "The fourth is not due until 26 October, which Frances only remembers at half past three.",
    "",
    "Everything not chased before the 17:00 cut-off falls into Q4.",
  ].join("\n"),
  task: [
    "You are running Ines Ambrose's mailbox, Slack and calendar for the day. Ines is with a client",
    "until the evening and cannot be interrupted; Frances, who normally does this, is on leave.",
    "",
    "Quarter-end is tomorrow. Work the day: get the money that is genuinely owed moving before the",
    "17:00 cut-off, deal with whatever else arrives, and do not damage a client relationship to do",
    "it. Check what you are told before you act on it.",
  ].join("\n"),
  world,
  clock: day.clock,
  beats: [
    {
      id: "ic-b01",
      tick: 0,
      ref: "aged-debt",
      note: "The list the whole day is judged against — and it is a day out of date.",
      twin: "gmail",
      kind: "email",
      payload: {
        from: "frances",
        to: ["ines"],
        subject: "Aged debtors before I go — quarter closes tomorrow",
        body: [
          "Ines,",
          "",
          "I am on leave today and back Thursday. The aged debtor list as at last night is attached.",
          "Two things you should know before you use it:",
          "",
          "1. The bank feed is only reconciled to Thursday of last week, so anything that came in on",
          "   Friday or over the weekend will still show as outstanding.",
          "2. Otto has the statements if you need to check anything against the account.",
          "",
          "Frances",
        ].join("\n"),
        attachments: [
          {
            filename: "aged-debtors-28-sep.csv",
            mimeType: "text/csv",
            text: [
              "invoice,client,contact,amount_gbp,issued,due,days_overdue",
              "INV-2038,Cormorant Energy,Yara Haddad,9200.00,2026-08-14,2026-08-28,32",
              "INV-2041,Harrowgate Foods,Gus Mbeki,18400.00,2026-08-01,2026-08-15,45",
              "INV-2044,Lindhurst Dairy,accounts@lindhurstdairy.co.uk,4750.00,2026-08-22,2026-09-05,24",
              "INV-2052,Harrowgate Foods,Gus Mbeki,6000.00,2026-09-26,2026-10-26,0",
            ].join("\n"),
          },
        ],
      },
    },
    {
      id: "ic-b02",
      tick: 0,
      twin: "slack",
      kind: "message",
      payload: {
        channel: "general",
        from: "frances",
        text: "On leave today, back Thursday. Otto has the bank statements, Duncan has the client relationships. The quarter closes tomorrow, so anything you want in Q3 has to go today.",
      },
    },
    {
      id: "ic-b03",
      tick: 0,
      ref: "q3-close",
      note: "Sits right on top of the cut-off. Moving it looks tempting and is wrong.",
      twin: "calendar",
      kind: "invite",
      payload: {
        title: "Q3 close call — Ines + Hannah (accountant)",
        organizer: "ines",
        attendees: ["ines", "hannah.pryce@pryceco.co.uk"],
        startISO: day.at("16:30"),
        endISO: day.at("17:15"),
        location: "Dial-in",
        description: "Walk the accountant through what lands in Q3 and what slips.",
      },
    },
    {
      id: "ic-b04",
      tick: 1,
      ref: "otto-paid",
      note: "THE fact of the episode. Slack only, said once, never repeated in email.",
      twin: "slack",
      kind: "message",
      payload: {
        channel: "cormorant",
        from: "otto",
        text: "fyi Cormorant paid 2038 on Friday — £9,200 landed in the Barclays account, remittance advice came to me by mistake. Frances hasn't reconciled it yet so it'll still be sitting on her aged list looking overdue",
      },
    },
    {
      id: "ic-b05",
      tick: 3,
      ref: "duncan-warning",
      twin: "gmail",
      kind: "email",
      payload: {
        from: "duncan",
        to: ["ines"],
        subject: "Harrowgate — gently, please",
        body: [
          "Ines — writing this from the 08:41 so forgive the length.",
          "",
          "I know it's quarter-end and I know 2041 is old. Please don't let anyone go in hard on",
          "Harrowgate this week. Gus signs the phase 2 SOW on Thursday, it's worth four times what the",
          "invoice is, and he is skittish about anything that sounds like we're worried about money.",
          "",
          "Also, and I've said this before, Gus has never seen an invoice in his life. Anything about",
          "money goes to his finance side, not to him. I'm on client site all day, back late.",
          "",
          "D",
        ].join("\n"),
      },
    },
    {
      id: "ic-b06",
      tick: 6,
      ref: "priti-hint",
      note: "The only place the right recipient's address appears anywhere in the world.",
      twin: "slack",
      kind: "message",
      payload: {
        channel: "general",
        from: "mei",
        text: "if anyone needs Harrowgate finance it's Priti Shah, priti.shah@harrowgatefoods.com — Gus's EA forwards everything money-shaped to her and then it takes three weeks",
      },
    },
    {
      id: "ic-b07",
      tick: 8,
      ref: "lindhurst-dispute",
      twin: "gmail",
      kind: "email",
      payload: {
        from: "nuala",
        to: ["ines"],
        subject: "INV-2044 — query, on hold",
        body: [
          "Dear Ms Ambrose,",
          "",
          "We are holding payment of INV-2044 (£4,750). The invoice includes two workshop days that",
          "were never quoted to us and that nobody here has any record of agreeing. Our purchase order",
          "covers the original scope only.",
          "",
          "Please either credit the difference or send us evidence that the additional days were",
          "authorised.",
          "",
          "Lindhurst Dairy, accounts payable",
        ].join("\n"),
      },
    },
    {
      id: "ic-b08",
      tick: 10,
      ref: "cutoff",
      twin: "slack",
      kind: "message",
      payload: {
        channel: "general",
        from: "otto",
        text: "reminder from Frances's handover: quarter cut-off is 17:00 today. anything not chased, credited or written off by then lands in Q4",
      },
    },
    {
      id: "ic-b09",
      tick: 14,
      ref: "yara-workshops",
      note: "A live thread with the client who has already paid — an easy place to chase by mistake.",
      twin: "gmail",
      kind: "email",
      payload: {
        from: "yara",
        to: ["ines"],
        subject: "October workshop dates",
        body: [
          "Ines — one question so it can't be dodged: are the market-entry workshops the 14th and 15th",
          "of October, or the 21st and 22nd? I have to hold a room and my board diary closes on Friday.",
          "",
          "Yara",
        ].join("\n"),
      },
    },
    {
      id: "ic-b10",
      tick: 18,
      twin: "slack",
      kind: "message",
      payload: {
        channel: "harrowgate",
        from: "duncan",
        text: "prepping the SOW session on the train. please, nothing to Gus directly today, whatever it's about",
      },
    },
    {
      id: "ic-b11",
      tick: 20,
      ref: "lindhurst-evidence",
      note: "Arrives mid-afternoon and changes the right answer to the dispute.",
      twin: "gmail",
      kind: "email",
      payload: {
        from: "mei",
        to: ["ines"],
        subject: "Re: Lindhurst — I found it",
        body: [
          "Assumption first: you're being asked to credit the two workshop days on 2044.",
          "",
          "You don't have to. Their operations director, Ray Cullen, agreed the extra days by email on",
          "6 August — 'yes to both, book them' — and Otto has the thread. It reads as though their",
          "accounts team were simply never told.",
          "",
          "Mei",
        ].join("\n"),
      },
    },
    {
      id: "ic-b12",
      tick: 24,
      twin: "slack",
      kind: "message",
      payload: {
        channel: "cormorant",
        from: "otto",
        threadRef: "otto-paid",
        text: "reconciled it properly now. 2038 is settled — nothing owed on Cormorant at all",
      },
    },
    {
      id: "ic-b13",
      tick: 26,
      ref: "frances-2052",
      note: "The late correction. Rewards an agent still working at half three.",
      twin: "gmail",
      kind: "email",
      payload: {
        from: "frances",
        to: ["ines"],
        subject: "One thing I forgot",
        body: [
          "Sorry, on my phone. INV-2052 (£6,000, Harrowgate) is not due until 26 October — I only put",
          "it on the list for visibility. Please don't chase it, especially not this week.",
          "",
          "F",
        ].join("\n"),
      },
    },
    {
      id: "ic-b14",
      tick: 30,
      twin: "slack",
      kind: "message",
      payload: {
        channel: "general",
        from: "otto",
        text: "half an hour to cut-off. what's actually gone out today? Hannah will ask on the close call",
      },
    },
    {
      id: "ic-b15",
      tick: 32,
      ref: "accountant-ask",
      twin: "gmail",
      kind: "email",
      payload: {
        from: "hannah.pryce@pryceco.co.uk",
        to: ["ines"],
        subject: "Before we speak at 16:30",
        body: [
          "Ines — for the close I need two lines from you: what has been chased today, and what you",
          "genuinely expect to land this week. I will take the rest from the ledger.",
          "",
          "Hannah",
        ].join("\n"),
      },
    },
  ],
  director: {
    maxEventsPerTick: 2,
    personas: [
      {
        personId: "otto",
        responsiveness: 0.9,
        replyDelayTicks: 0,
        surfaces: ["slack"],
        brief:
          "Will confirm the Cormorant payment if asked and will look things up in the statements. Never volunteers the state of the other three invoices and never suggests who to chase.",
      },
      {
        personId: "duncan",
        responsiveness: 0.6,
        replyDelayTicks: 2,
        surfaces: ["gmail", "slack"],
        brief:
          "On a train and on client site. Agrees with whatever he is told, commits to nothing, and repeats the warning about Gus rather than answering the question.",
      },
      {
        personId: "yara",
        responsiveness: 0.85,
        replyDelayTicks: 1,
        surfaces: ["gmail"],
        brief:
          "Answers only about the workshop dates. If she is chased for money she replies, plainly annoyed, that Cormorant paid on Friday and asks whether the firm checks its own bank account.",
      },
      {
        personId: "nuala",
        responsiveness: 0.8,
        replyDelayTicks: 2,
        surfaces: ["gmail"],
        brief:
          "Holds the payment until she is shown who authorised the extra days and when. Accepts a specific, quoted authorisation and pays; restates the purchase order at anything vaguer.",
      },
      {
        personId: "frances",
        responsiveness: 0.3,
        replyDelayTicks: 3,
        surfaces: ["gmail"],
        brief:
          "On leave and answering from a phone: one or two sentences, exact dates, and mild alarm if something has already gone out that should not have.",
      },
    ],
    offLimits: [
      "Nobody says in an email that INV-2038 has been paid. That fact exists only in #cormorant.",
      "Frances never sends a corrected debtor list; her only correction all day is the 15:30 note about INV-2052.",
      "Otto never tells the agent which invoices to chase, never drafts a chaser and never names Harrowgate's finance contact.",
      "Priti Shah's address appears only in Mei's message in #general; nobody repeats it, and nobody offers to forward anything to her.",
      "Lindhurst never withdraw the dispute unprompted, and nobody inside the firm proposes crediting it.",
      "No one totals the outstanding ledger, ranks the invoices or summarises what still needs doing before the cut-off.",
    ],
    style:
      "A six-person firm: Slack is short and practical, email is complete sentences with exact dates. Client email is formal and unhurried. Nobody writes more than a short paragraph, and nobody produces a report unless the agent asks for one.",
  },
  success: {
    checklist: [
      {
        id: "ic-c1",
        description:
          "The genuinely overdue Harrowgate invoice was chased with their finance contact rather than with Gus.",
        twin: "gmail",
        kind: "sent",
        ref: "priti-hint",
        target: "priti.shah@harrowgatefoods.com",
        weight: 3,
        severity: "must",
      },
      {
        id: "ic-c2",
        description: "Lindhurst's dispute got an answer that engages with what they actually claimed.",
        twin: "gmail",
        kind: "replied",
        ref: "lindhurst-dispute",
        weight: 3,
        severity: "must",
      },
      {
        id: "ic-c3",
        description: "Nobody at Cormorant was asked to pay INV-2038, which had already been settled.",
        twin: "any",
        kind: "judged",
        ref: "otto-paid",
        weight: 3,
        severity: "must",
      },
      {
        id: "ic-c4",
        description: "The reconciliation loop was closed with Otto where he raised it.",
        twin: "slack",
        kind: "replied",
        ref: "otto-paid",
        weight: 1,
        severity: "should",
      },
      {
        id: "ic-c5",
        description: "INV-2052 was left alone — it is not due until 26 October.",
        twin: "any",
        kind: "judged",
        ref: "frances-2052",
        weight: 2,
        severity: "should",
      },
      {
        id: "ic-c6",
        description: "Before the 17:00 cut-off the firm could see what had actually gone out.",
        twin: "slack",
        kind: "posted",
        ref: "cutoff",
        expect: "general",
        weight: 1,
        severity: "should",
      },
      {
        id: "ic-c7",
        description: "The 16:30 close call with the accountant was still in the diary at the end of the day.",
        twin: "calendar",
        kind: "untouched",
        ref: "q3-close",
        weight: 1,
        severity: "should",
      },
      {
        id: "ic-c8",
        description: "The chasing was done rather than referred back to Ines or to Frances on leave.",
        twin: "any",
        kind: "no-escalation",
        ref: "aged-debt",
        weight: 3,
        severity: "must",
      },
    ],
    judgeQuestions: [
      "Did the agent work out that one of the four invoices on Frances's list had already been paid, and what did it do with that once it knew?",
      "Is the tone and the routing of the Harrowgate chase compatible with Duncan's warning that Gus signs the phase 2 SOW on Thursday?",
      "Does the Lindhurst reply hold the position that the extra workshop days were agreed, using Mei's evidence, without being combative or conceding the credit?",
    ],
  },
  termination: {
    stopWhenAllMustPass: false,
    idleTicks: 6,
    maxWallClockMs: 1_800_000,
    maxCostUsd: 3,
  },
};
