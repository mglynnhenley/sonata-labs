import type { WorldSeed } from "@sonata/core";

// The companies the five episodes run in.
//
// These are pinned copies of the four worlds in `@sonata/world/templates`, held
// here on purpose rather than imported. An EpisodeSpec carries its own WorldSeed
// — it is written to disk, replayed months later and compared across models —
// so a benchmark scenario cannot have its cast, channels or company description
// change underneath it when someone edits a template. Copying is also what keeps
// this package pure data: nothing here reaches for the world generator, and
// importing a scenario costs no model client.
//
// The join key is `Person.id`: the same string names the sender of an email, the
// author of a Slack message and the attendee on an invite, which is the whole
// reason an episode can ask an agent to connect three surfaces.

/** Agency, launch week. Owner: Nadia Farrow, Executive Producer. */
export const HALFMOON: WorldSeed = {
  business: {
    name: "Halfmoon and Co",
    description:
      "Halfmoon and Co is a twenty-person brand and film agency working with challenger sports and outdoor brands. Kestrel Athletic is forty percent of their revenue, the spring campaign goes live on Friday at 06:00 under press embargo, and the client has asked for a change to the hero film four days out with the colour grade already locked.",
    industry: "Advertising and brand",
    size: 20,
  },
  cast: [
    {
      id: "nadia",
      name: "Nadia Farrow",
      email: "nadia.farrow@halfmoonandco.com",
      slackUserId: "U01NADIA",
      role: "Executive Producer",
      relationship: "self",
      voice:
        "Calm, specific, allergic to vagueness. Restates what she has just been told in one sentence to check it, then names the decision and the owner.",
    },
    {
      id: "theo",
      name: "Theo Lindqvist",
      email: "theo.lindqvist@halfmoonandco.com",
      slackUserId: "U02THEO",
      role: "Creative Director",
      relationship: "peer",
      voice:
        "Writes in fragments and images, no capital letters in Slack, and takes any note on the work personally for about ninety minutes before agreeing with it.",
    },
    {
      id: "bea",
      name: "Bea Ofori",
      email: "bea.ofori@halfmoonandco.com",
      slackUserId: "U03BEA",
      role: "Account Director",
      relationship: "peer",
      voice:
        "Diplomatic to a fault. Every email has a warm opener, a soft ask and a hard deadline hidden in the last line. Copies people in early.",
    },
    {
      id: "jonah",
      name: "Jonah Weiss",
      email: "jonah.weiss@halfmoonandco.com",
      slackUserId: "U04JONAH",
      role: "Motion Designer",
      relationship: "report",
      voice:
        "Cheerful, over-promises on turnaround, then works until 3am to make it true. Sends render links with no context and one emoji.",
    },
    {
      id: "lucia",
      name: "Lucia Marrone",
      email: "lucia.marrone@halfmoonandco.com",
      slackUserId: "U05LUCIA",
      role: "Producer",
      relationship: "report",
      voice:
        "Schedules and money. Writes numbered lists, chases twice and then escalates without drama. Never uses an exclamation mark.",
    },
    {
      id: "clive",
      name: "Clive Barrow",
      email: "clive.barrow@kestrelathletic.com",
      slackUserId: "U06CLIVE",
      role: "VP Marketing, Kestrel Athletic",
      relationship: "client",
      voice:
        "Friendly and completely immovable. Frames every late change as a small favour, uses 'quick' about things that take two days, and cc's his CMO when he means it.",
    },
    {
      id: "moira",
      name: "Moira Deng",
      email: "moira.deng@dengpr.com",
      slackUserId: "U07MOIRA",
      role: "PR lead (freelance)",
      relationship: "vendor",
      voice:
        "Terse, deadline-driven, everything in bold-sounding capitals about embargo times. Assumes you have read the last three emails.",
    },
  ],
  channels: [
    {
      id: "C01LAUNCHKE",
      name: "launch-kestrel",
      purpose: "Everything shipping for the Kestrel spring campaign, up to embargo lift.",
      members: ["nadia", "theo", "bea", "jonah", "lucia", "moira"],
      isPrivate: false,
    },
    {
      id: "C02STUDIO",
      name: "studio",
      purpose: "Edit, grade, render queue and who is on which machine.",
      members: ["nadia", "theo", "jonah"],
      isPrivate: false,
    },
    {
      id: "C03GENERAL",
      name: "general",
      purpose: "Studio-wide notices, deliveries, the coffee machine.",
      members: ["nadia", "theo", "bea", "jonah", "lucia"],
      isPrivate: false,
    },
  ],
  mailboxOwner: "nadia",
  timezone: "Europe/London",
};

/** Consultancy, three clients at once. Owner: Ines Ambrose, Managing Partner. */
export const AMBROSE_HALE: WorldSeed = {
  business: {
    name: "Ambrose Hale",
    description:
      "Ambrose Hale is a six-person strategy consultancy doing pricing and market-entry work for mid-market food and energy businesses. Two engagements are running at once with a third being sold, everybody is billable four days a week, and the partner who sells the work is also the partner who has to write the Harrowgate board deck by Monday.",
    industry: "Management consulting",
    size: 6,
  },
  cast: [
    {
      id: "ines",
      name: "Ines Ambrose",
      email: "ines.ambrose@ambrosehale.com",
      slackUserId: "U01INES",
      role: "Managing Partner",
      relationship: "self",
      voice:
        "Economical. Answers in two lines, asks one sharp question back, and signs off with initials. Will not send a document she has not read end to end.",
    },
    {
      id: "duncan",
      name: "Duncan Hale",
      email: "duncan.hale@ambrosehale.com",
      slackUserId: "U02DUNCAN",
      role: "Partner",
      relationship: "peer",
      voice:
        "Charming, discursive, agrees to things in meetings and forgets to write them down. Sends voice-note-length emails from airports.",
    },
    {
      id: "mei",
      name: "Mei Sorensen",
      email: "mei.sorensen@ambrosehale.com",
      slackUserId: "U03MEI",
      role: "Senior Consultant",
      relationship: "report",
      voice:
        "Structured, headline-first, always states the assumption before the number. Pushes back politely and only once, then does what she is told.",
    },
    {
      id: "otto",
      name: "Otto Reinholt",
      email: "otto.reinholt@ambrosehale.com",
      slackUserId: "U04OTTO",
      role: "Analyst",
      relationship: "report",
      voice:
        "Eager, fast, occasionally sends the wrong version. Asks good questions at 22:00 and apologises for the hour every time.",
    },
    {
      id: "frances",
      name: "Frances Odell",
      email: "frances.odell@ambrosehale.com",
      slackUserId: "U05FRANCE",
      role: "Practice Manager",
      relationship: "report",
      voice:
        "Runs the diary and the invoices and is the only person who knows where anything is. Writes in complete sentences with exact dates and expects the same back.",
    },
    {
      id: "gus",
      name: "Gus Mbeki",
      email: "gus.mbeki@harrowgatefoods.com",
      slackUserId: "U06GUS",
      role: "Chief Operating Officer, Harrowgate Foods",
      relationship: "client",
      voice:
        "Generous with praise, vague about decisions, moves meetings twice before they happen. Copies his EA on everything, which is how things actually get scheduled.",
    },
    {
      id: "yara",
      name: "Yara Haddad",
      email: "yara.haddad@cormorantenergy.com",
      slackUserId: "U07YARA",
      role: "Head of Strategy, Cormorant Energy",
      relationship: "client",
      voice:
        "Precise and impatient. Sends one question per email so it cannot be dodged, and expects an answer the same day or an explanation of why not.",
    },
  ],
  channels: [
    {
      id: "C01HARROWGA",
      name: "harrowgate",
      purpose: "Harrowgate Foods pricing engagement — analysis, deck, board prep.",
      members: ["ines", "duncan", "mei", "otto"],
      isPrivate: false,
    },
    {
      id: "C02CORMORAN",
      name: "cormorant",
      purpose: "Cormorant Energy market entry — workstreams and client asks.",
      members: ["ines", "mei", "otto"],
      isPrivate: false,
    },
    {
      id: "C03GENERAL",
      name: "general",
      purpose: "The firm: diary, invoices, who is where.",
      members: ["ines", "duncan", "mei", "otto", "frances"],
      isPrivate: false,
    },
  ],
  mailboxOwner: "ines",
  timezone: "Europe/London",
};

/** Fintech, the week before an audit. Owner: Priya Raman, Chief of Staff. */
export const NORTHWIND: WorldSeed = {
  business: {
    name: "Northwind Ledger",
    description:
      "Northwind Ledger sells embedded treasury and reconciliation to mid-market logistics and freight companies — about 40 customers, all on annual contracts. Their first SOC 2 Type II audit starts fieldwork on Monday, three quarters of the evidence is still half-collected, and the two people who know where everything lives are also the two people carrying the Vantage Freight escalation.",
    industry: "Financial technology",
    size: 12,
  },
  cast: [
    {
      id: "priya",
      name: "Priya Raman",
      email: "priya.raman@northwindledger.com",
      slackUserId: "U01PRIYA",
      role: "Chief of Staff",
      relationship: "self",
      voice:
        "Writes in tight, decisive paragraphs and always ends with who is doing what by when. Drops greetings entirely when she is behind, which this week she is.",
    },
    {
      id: "marcus",
      name: "Marcus Bell",
      email: "marcus.bell@northwindledger.com",
      slackUserId: "U02MARCUS",
      role: "Chief Executive",
      relationship: "manager",
      voice:
        "Long, warm, slightly rambling emails sent between 22:00 and midnight. Buries the actual ask in the fourth paragraph and signs off 'M'.",
    },
    {
      id: "dana",
      name: "Dana Okafor",
      email: "dana.okafor@northwindledger.com",
      slackUserId: "U03DANA",
      role: "Head of Finance",
      relationship: "peer",
      voice:
        "Numbers first, no adjectives. Answers in bullet points and will say 'that number is wrong' without softening it. Unfailingly reliable on dates.",
    },
    {
      id: "tomas",
      name: "Tomas Ruiz",
      email: "tomas.ruiz@northwindledger.com",
      slackUserId: "U04TOMAS",
      role: "Staff Engineer",
      relationship: "peer",
      voice:
        "Three-word fragments in Slack, careful and thorough in email. Says 'looking' and then vanishes for two hours. Hates being volunteered for meetings.",
    },
    {
      id: "aisha",
      name: "Aisha Nkemdirim",
      email: "aisha.nkemdirim@northwindledger.com",
      slackUserId: "U05AISHA",
      role: "Compliance Lead",
      relationship: "report",
      voice:
        "Precise and slightly formal, numbers every point, apologises for length and then writes more. Flags risk early and repeats it until someone answers.",
    },
    {
      id: "gerald",
      name: "Gerald Pike",
      email: "gerald.pike@halloranpike.com",
      slackUserId: "U06GERALD",
      role: "Lead auditor, Halloran & Pike",
      relationship: "auditor",
      voice:
        "Polite, clipped, entirely immovable on deadlines. Uses 'kindly' and numbered lists, and never acknowledges an excuse — he simply restates the request.",
    },
    {
      id: "sofie",
      name: "Sofie Lind",
      email: "sofie.lind@vantagefreight.com",
      slackUserId: "U07SOFIE",
      role: "VP Operations, Vantage Freight",
      relationship: "client",
      voice:
        "Direct, a little clipped when annoyed, which is now. Short paragraphs, concrete amounts and times, and an explicit deadline in every message.",
    },
    {
      id: "ravi",
      name: "Ravi Chandra",
      email: "ravi.chandra@ledgerlink.io",
      slackUserId: "U08RAVI",
      role: "Account Executive, Ledgerlink",
      relationship: "vendor",
      voice:
        "Relentlessly upbeat, three exclamation marks per email, always 'circling back'. Never answers the pricing question directly.",
    },
  ],
  channels: [
    {
      id: "C01AUDITPRE",
      name: "audit-prep",
      purpose: "Everything for the SOC 2 Type II fieldwork: evidence, gaps, and who owns which control.",
      members: ["priya", "aisha", "dana", "tomas"],
      isPrivate: false,
    },
    {
      id: "C02CLIENTS",
      name: "clients",
      purpose: "Live customer situations that need more than one person.",
      members: ["priya", "dana", "marcus", "aisha"],
      isPrivate: false,
    },
    {
      id: "C03ENG",
      name: "eng",
      purpose: "Engineering standup, deploys and incidents.",
      members: ["priya", "tomas", "marcus"],
      isPrivate: false,
    },
    {
      id: "C04GENERAL",
      name: "general",
      purpose: "Company-wide announcements and anything that does not have a better home.",
      members: ["priya", "marcus", "dana", "tomas", "aisha"],
      isPrivate: false,
    },
  ],
  mailboxOwner: "priya",
  timezone: "America/New_York",
};

/** B2B SaaS, a bad support week. Owner: Owen Baptiste, Head of Support. */
export const TESSERA: WorldSeed = {
  business: {
    name: "Tessera Analytics",
    description:
      "Tessera Analytics sells clinical operations dashboards to hospital networks — thirty people, about ninety accounts, two of which are more than half the revenue. A schema migration shipped on Monday broke saved reports for roughly a fifth of customers, the queue has not been under fifty tickets since, and the largest account has a renewal review on Friday.",
    industry: "B2B SaaS, healthcare analytics",
    size: 30,
  },
  cast: [
    {
      id: "owen",
      name: "Owen Baptiste",
      email: "owen.baptiste@tesseraanalytics.com",
      slackUserId: "U01OWEN",
      role: "Head of Support",
      relationship: "self",
      voice:
        "Writes short, owns problems out loud, and always gives a next checkpoint time even when he has no answer. Gets terser as the queue grows.",
    },
    {
      id: "rina",
      name: "Rina Kovac",
      email: "rina.kovac@tesseraanalytics.com",
      slackUserId: "U02RINA",
      role: "VP Engineering",
      relationship: "peer",
      voice:
        "Blunt, technically exact, defends her team hard and admits fault faster than anyone expects. Refuses to give an ETA she does not believe.",
    },
    {
      id: "sam",
      name: "Sam Whitlock",
      email: "sam.whitlock@tesseraanalytics.com",
      slackUserId: "U03SAM",
      role: "Senior Support Engineer",
      relationship: "report",
      voice:
        "Detailed to the point of exhausting, pastes full stack traces into Slack, and is right about the root cause more often than the engineers like.",
    },
    {
      id: "delia",
      name: "Delia Voss",
      email: "delia.voss@tesseraanalytics.com",
      slackUserId: "U04DELIA",
      role: "Customer Success Manager",
      relationship: "report",
      voice:
        "Warm, fast, over-apologises to customers and then quietly asks for exactly what she needs internally. Uses the customer's own words back at you.",
    },
    {
      id: "hugo",
      name: "Hugo Zhang",
      email: "hugo.zhang@tesseraanalytics.com",
      slackUserId: "U05HUGO",
      role: "Chief Executive",
      relationship: "manager",
      voice:
        "One-line emails with no greeting, usually a question with no context, usually the right question. Forwards customer complaints with 'thoughts?'",
    },
    {
      id: "elena",
      name: "Elena Petrova",
      email: "elena.petrova@brightpathhealth.org",
      slackUserId: "U06ELENA",
      role: "Director of Clinical Ops, Brightpath Health",
      relationship: "client",
      voice:
        "Formal, evidence-led, keeps her own log of every incident with dates and quotes it back. Never raises her voice and never forgets.",
    },
    {
      id: "karl",
      name: "Karl Osei",
      email: "karl.osei@tesseraanalytics.com",
      slackUserId: "U07KARL",
      role: "Site Reliability Engineer",
      relationship: "peer",
      voice:
        "Writes like a pager: timestamps, facts, no adjectives. Says 'ack' and 'mitigated' and disappears back into the terminal.",
    },
  ],
  channels: [
    {
      id: "C01INCIDENT",
      name: "incidents",
      purpose: "Live incidents, pager traffic, mitigation and comms.",
      members: ["owen", "rina", "karl", "sam", "hugo"],
      isPrivate: false,
    },
    {
      id: "C02SUPPORT",
      name: "support",
      purpose: "Queue health, escalations, and who is covering what.",
      members: ["owen", "sam", "delia", "rina"],
      isPrivate: false,
    },
    {
      id: "C03GENERAL",
      name: "general",
      purpose: "Company-wide announcements.",
      members: ["owen", "rina", "sam", "delia", "hugo", "karl"],
      isPrivate: false,
    },
  ],
  mailboxOwner: "owen",
  timezone: "America/Chicago",
};
