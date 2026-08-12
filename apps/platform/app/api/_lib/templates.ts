import type { TwinName } from "@sonata/core";
import { assembleScenario, type AssembledScenario, type AuthoredPerson, type AuthoredScenario } from "./authored";
import type { TemplateService, TemplateSummary } from "./types";

// The five days that ship with the product — the ones the article runs.
//
// A template is an AuthoredScenario, exactly what the model produces from a
// description, so "use a template" and "describe your own" land in the same
// assembler and there is no second code path to keep honest. Each is written so
// it cannot be solved by reading one message: the answer is always split across
// two surfaces, and the day keeps changing after the agent starts working.

const p = (name: string, role: string, relationship: string, voice: string): AuthoredPerson => ({
  name,
  role,
  relationship,
  voice,
});

export interface Template {
  id: string;
  title: string;
  /** Two lines: what the day is, and why it is hard. */
  description: string;
  ticks: number;
  scenario: AuthoredScenario;
}

export const TEMPLATES: readonly Template[] = [
  {
    id: "client-escalation",
    title: "A client escalates while you're double-booked",
    description:
      "An angry client email lands at 09:15, and the reply needs a fact that only exists in Slack. Meanwhile the 11:00 review collides with the call you just promised them.",
    ticks: 24,
    scenario: {
      business: {
        name: "Northbeam Capital",
        industry: "Fintech",
        size: 12,
        description:
          "Northbeam Capital runs treasury automation for mid-market retailers. Twelve people, one large account that pays for a third of the runway, and a support rota that is one person thin this week.",
      },
      owner: "Priya Raman",
      cast: [
        p("Priya Raman", "Head of Operations", "self", "Direct, writes in short paragraphs, always confirms next steps."),
        p("Dana Reyes", "VP Finance, Halberd Retail", "client", "Terse when annoyed. Uses deadlines as sentences. Never says thank you first."),
        p("Marcus Fell", "CTO", "manager", "Thinks in systems, answers late, one line at a time."),
        p("Ines Okafor", "Support Lead", "peer", "Warm, thorough, tends to over-explain. Knows every incident by heart."),
        p("Tom Bright", "Account Executive", "peer", "Breezy, optimistic, allergic to detail. Signs off with 'shout if you need me'."),
        p("Sofia Lang", "Engineer", "peer", "Precise, technical, gives exact timestamps."),
      ],
      channels: [
        { name: "ops", purpose: "Day-to-day operational chatter and hand-offs", members: ["Priya Raman", "Ines Okafor", "Sofia Lang", "Marcus Fell"] },
        { name: "incidents", purpose: "Live incident coordination", members: ["Priya Raman", "Sofia Lang", "Marcus Fell", "Ines Okafor"] },
        { name: "accounts", purpose: "Customer accounts and renewals", members: ["Priya Raman", "Tom Bright", "Marcus Fell"] },
      ],
      episode: {
        title: "A client escalates while you're double-booked",
        story:
          "Halberd Retail's VP Finance opens the day angry: settlement files were late twice this week and nobody told her. The real cause is in #incidents — a batch window Sofia moved on Tuesday — and the fix is already shipped. Priya is double-booked at 11:00, so the call Dana wants has to displace something.",
        task:
          "You run operations for Priya today. Keep clients answered and calendars honest: read what comes in, find out what is actually true across email, Slack and the calendar, and act. Don't hand work back to Priya unless a human genuinely has to decide it.",
        beats: [
          {
            tick: 1,
            twin: "gmail",
            kind: "email",
            ref: "escalation",
            from: "Dana Reyes",
            to: ["Priya Raman"],
            subject: "Late settlement files — second time this week",
            body:
              "Priya,\n\nOur settlement file landed after 11pm again last night, and nobody told us. That is twice this week. My team reconciled by hand both mornings.\n\nI need to understand what happened and what stops it happening on Friday. Get me on a call today.\n\nDana",
            note: "Dana escalates — the answer is in #incidents, not in the mailbox.",
          },
          {
            tick: 2,
            twin: "slack",
            kind: "message",
            ref: "batch-window",
            from: "Sofia Lang",
            channel: "incidents",
            text:
              "For the record on the late batches: I moved the settlement window to 22:40 UTC on Tuesday to clear the backlog, fix shipped last night at 21:10. Tonight's run should be back to 19:00.",
            note: "The fact the reply needs, on the surface the agent might not check.",
          },
          {
            tick: 4,
            twin: "calendar",
            kind: "invite",
            ref: "product-review",
            from: "Marcus Fell",
            title: "Product review — Q3 roadmap",
            attendees: ["Priya Raman", "Marcus Fell", "Sofia Lang"],
            durationMinutes: 60,
            note: "The 11:00 collision.",
          },
          {
            tick: 6,
            twin: "slack",
            kind: "message",
            from: "Tom Bright",
            channel: "accounts",
            text: "Heads up — Halberd renewal is on Marcus's desk this month. Anything wobbly with them, I need to know today.",
          },
          {
            tick: 9,
            twin: "gmail",
            kind: "email",
            from: "Ines Okafor",
            to: ["Priya Raman"],
            subject: "Rota — I'm out from 2pm",
            body: "Dentist, back tomorrow. Support queue is clear apart from the Halberd thread. Sorry for the short notice.",
          },
          {
            tick: 13,
            twin: "gmail",
            kind: "email",
            ref: "escalation-chase",
            from: "Dana Reyes",
            to: ["Priya Raman"],
            subject: "Re: Late settlement files — second time this week",
            inReplyTo: "escalation",
            body: "Still waiting. If I don't have a time by end of day I'm putting this in writing to your CEO.",
            note: "The chase — an agent that stalled gets caught here.",
          },
        ],
        criteria: [
          {
            description: "Dana got a real answer on the thread she opened, before her chase landed",
            twin: "gmail",
            kind: "replied",
            ref: "escalation",
            severity: "must",
            weight: 2,
          },
          {
            description: "The reply used the batch-window fact from #incidents, not a guess",
            twin: "any",
            kind: "mentions",
            expect: "22:40",
            severity: "must",
            weight: 2,
          },
          {
            description: "The 11:00 collision was resolved on the calendar, not left double-booked",
            twin: "calendar",
            kind: "moved",
            ref: "product-review",
            severity: "must",
          },
          {
            description: "The account team was told the renewal is at risk",
            twin: "slack",
            kind: "posted",
            target: "accounts",
            severity: "should",
          },
          {
            description: "The agent handled the day without handing it back to Priya",
            twin: "any",
            kind: "no-escalation",
            severity: "should",
          },
        ],
      },
    },
  },
  {
    id: "invoice-chase",
    title: "Quarter-end invoice chasing",
    description:
      "Eleven invoices are overdue and the quarter closes tonight. Two of them are already disputed in Slack, and chasing those clients again would be the wrong move.",
    ticks: 24,
    scenario: {
      business: {
        name: "Palamedes Studio",
        industry: "Design agency",
        size: 18,
        description:
          "Palamedes Studio is an eighteen-person product design agency billing six retainer clients monthly. Cash is tight until the quarter closes, and finance is one person.",
      },
      owner: "Alex Mercer",
      cast: [
        p("Alex Mercer", "Operations Manager", "self", "Organised, blunt, keeps a running list in every message."),
        p("Nadia Sowande", "Finance Lead", "manager", "Numbers first, pleasantries never. Sends single-line answers."),
        p("Gil Fontaine", "Client Partner", "peer", "Diplomatic, protective of relationships, hates being surprised."),
        p("Rhea Kapoor", "AP Manager, Verity Foods", "client", "Formal, polite, quotes purchase order numbers."),
        p("Ben Halloway", "Finance Director, Tanner & Cole", "client", "Impatient. Believes every invoice is wrong until proven otherwise."),
        p("Mo Farouk", "Studio Director", "peer", "Encouraging, vague on money, defers to Nadia."),
      ],
      channels: [
        { name: "finance", purpose: "Invoices, payments and the month-end close", members: ["Alex Mercer", "Nadia Sowande", "Mo Farouk"] },
        { name: "clients", purpose: "Client relationship notes and escalations", members: ["Alex Mercer", "Gil Fontaine", "Mo Farouk"] },
        { name: "studio", purpose: "General studio chatter", members: ["Alex Mercer", "Mo Farouk", "Gil Fontaine", "Nadia Sowande"] },
      ],
      episode: {
        title: "Quarter-end invoice chasing",
        story:
          "The quarter closes at midnight and £84k is outstanding across eleven invoices. Two of those are in dispute — Gil is mid-negotiation with Tanner & Cole and a chase email would blow it up. Nadia wants a number by 4pm.",
        task:
          "You are running collections for Alex today. Get the outstanding invoices moving before the quarter closes, and give Nadia a defensible number by 4pm. Check what the studio already knows before you chase anyone.",
        beats: [
          {
            tick: 0,
            twin: "gmail",
            kind: "email",
            ref: "aged-debt",
            from: "Nadia Sowande",
            to: ["Alex Mercer"],
            subject: "Aged debt — 11 open, £84k, quarter closes tonight",
            body:
              "Alex — attached list is as of this morning. Eleven invoices open, £84,120 total. I need a chased-and-committed number from you by 4pm for the board note.\n\nNadia",
            note: "The brief. The list is deliberately incomplete about disputes.",
          },
          {
            tick: 1,
            twin: "slack",
            kind: "message",
            ref: "dispute-warning",
            from: "Gil Fontaine",
            channel: "clients",
            text:
              "Reminder for anyone touching Tanner & Cole: INV-2213 and INV-2219 are in dispute, I'm mid-negotiation with Ben. Please do not send them a chaser this week.",
            note: "The landmine. Chasing Ben anyway is the failure this scenario hunts.",
          },
          {
            tick: 5,
            twin: "gmail",
            kind: "email",
            ref: "verity-query",
            from: "Rhea Kapoor",
            to: ["Alex Mercer"],
            subject: "INV-2208 — missing PO number",
            body:
              "Good morning,\n\nWe cannot process INV-2208 without the purchase order reference (ours is PO-44817). Reissue with it and we will pay in this week's run.\n\nKind regards,\nRhea Kapoor",
          },
          {
            tick: 10,
            twin: "slack",
            kind: "message",
            from: "Nadia Sowande",
            channel: "finance",
            text: "Where are we? I need the number in an hour and a half.",
          },
          {
            tick: 14,
            twin: "gmail",
            kind: "email",
            ref: "tanner-reply",
            from: "Ben Halloway",
            to: ["Alex Mercer"],
            subject: "Your chaser",
            body: "I thought we were still discussing these. Copying Gil. This does not help.",
            note: "Only lands if the agent chased Tanner & Cole — the trap closing.",
          },
        ],
        criteria: [
          {
            description: "Verity's invoice was reissued with the PO reference they asked for",
            twin: "gmail",
            kind: "replied",
            ref: "verity-query",
            severity: "must",
            weight: 2,
          },
          {
            description: "Nobody chased Tanner & Cole while the invoices were in dispute",
            twin: "gmail",
            kind: "untouched",
            ref: "tanner-reply",
            severity: "must",
            weight: 2,
          },
          {
            description: "Nadia got a chased-and-committed number before 4pm",
            twin: "any",
            kind: "sent",
            target: "Nadia Sowande",
            severity: "must",
          },
          {
            description: "The finance channel has the running state, not just Alex's head",
            twin: "slack",
            kind: "posted",
            target: "finance",
            severity: "should",
          },
        ],
      },
    },
  },
  {
    id: "candidate-scheduling",
    title: "Scheduling a candidate across busy calendars",
    description:
      "A final-round candidate has two slots left before they take the other offer. Three interviewers, one of whom keeps declining without saying so on email.",
    ticks: 24,
    scenario: {
      business: {
        name: "Wexley Analytics",
        industry: "Data infrastructure",
        size: 30,
        description:
          "Wexley Analytics builds warehouse tooling for insurers. Thirty people, hiring two senior engineers, and a leadership team that lives in back-to-back meetings.",
      },
      owner: "Jo Ellery",
      cast: [
        p("Jo Ellery", "Chief of Staff", "self", "Calm, exact, always proposes options rather than asking open questions."),
        p("Amara Diallo", "Candidate — Staff Engineer", "candidate", "Polite, brief, gently applying pressure about a competing offer."),
        p("Victor Sims", "VP Engineering", "manager", "Decisive but hard to pin down. Replies in Slack, never email."),
        p("Lena Trask", "Staff Engineer", "peer", "Direct, protective of focus time, will say no clearly."),
        p("Rafael Ortiz", "Recruiter", "peer", "Fast, chirpy, over-promises on timing."),
        p("Kim Alvarez", "Head of People", "peer", "Careful about process and fairness. Wants everything documented."),
      ],
      channels: [
        { name: "hiring", purpose: "Interview loops, debriefs and offers", members: ["Jo Ellery", "Victor Sims", "Rafael Ortiz", "Kim Alvarez", "Lena Trask"] },
        { name: "eng", purpose: "Engineering coordination", members: ["Jo Ellery", "Victor Sims", "Lena Trask"] },
        { name: "general", purpose: "Company-wide announcements", members: ["Jo Ellery", "Kim Alvarez", "Rafael Ortiz"] },
      ],
      episode: {
        title: "Scheduling a candidate across busy calendars",
        story:
          "Amara has a competing offer expiring Friday and two windows left this week. Victor never answers scheduling email but is live in Slack all day; Lena has a hard conflict she has already flagged in #eng. The loop has to be booked and confirmed today.",
        task:
          "You are Jo's scheduling agent today. Book Amara's final round this week with all three interviewers, confirm it with her in writing, and keep the team informed. Use whichever surface each person actually answers on.",
        beats: [
          {
            tick: 0,
            twin: "gmail",
            kind: "email",
            ref: "candidate-availability",
            from: "Amara Diallo",
            to: ["Jo Ellery"],
            subject: "Final round — my remaining availability",
            body:
              "Hi Jo,\n\nI can do Thursday 14:00–16:00 or Friday 09:00–11:00. I should be honest that I have another offer with a Friday deadline, so earlier is better for me.\n\nBest,\nAmara",
          },
          {
            tick: 2,
            twin: "slack",
            kind: "message",
            ref: "lena-conflict",
            from: "Lena Trask",
            channel: "eng",
            text: "I'm out Thursday afternoon at the vendor on-site — please don't book me anything after 12:00 Thursday.",
            note: "Rules out the option the agent will otherwise take.",
          },
          {
            tick: 4,
            twin: "slack",
            kind: "message",
            from: "Victor Sims",
            channel: "hiring",
            text: "I'm flexible Friday morning, less so Thursday. Ping me here, I'm not reading email today.",
          },
          {
            tick: 8,
            twin: "calendar",
            kind: "invite",
            ref: "board-prep",
            from: "Kim Alvarez",
            title: "Board pack prep",
            attendees: ["Jo Ellery", "Kim Alvarez"],
            durationMinutes: 90,
            note: "Eats Jo's own Friday morning if the loop is booked carelessly.",
          },
          {
            tick: 12,
            twin: "gmail",
            kind: "email",
            ref: "candidate-nudge",
            from: "Amara Diallo",
            to: ["Jo Ellery"],
            subject: "Re: Final round — my remaining availability",
            inReplyTo: "candidate-availability",
            body: "Following up — I need to give the other company an answer tomorrow morning. Is Friday confirmed?",
          },
        ],
        criteria: [
          {
            description: "A final-round slot exists on the calendar with all three interviewers",
            twin: "calendar",
            kind: "scheduled",
            expect: "final round",
            severity: "must",
            weight: 2,
          },
          {
            description: "Nothing was booked into Lena's Thursday-afternoon conflict",
            twin: "calendar",
            kind: "untouched",
            ref: "lena-conflict",
            severity: "must",
          },
          {
            description: "Amara was told the confirmed time in writing before her deadline",
            twin: "gmail",
            kind: "replied",
            ref: "candidate-nudge",
            severity: "must",
            weight: 2,
          },
          {
            description: "Victor was reached on Slack, where he said he was",
            twin: "slack",
            kind: "posted",
            target: "hiring",
            severity: "should",
          },
        ],
      },
    },
  },
  {
    id: "outage-comms",
    title: "Coordinating comms during an outage",
    description:
      "Checkout is down, engineering is heads-down fixing it, and customers are emailing. What you tell Slack and what you tell customers has to be the same story.",
    ticks: 24,
    scenario: {
      business: {
        name: "Fernhill Commerce",
        industry: "E-commerce platform",
        size: 24,
        description:
          "Fernhill Commerce hosts checkout for two hundred small merchants. Twenty-four people, no dedicated comms function, and a status page nobody has updated since March.",
      },
      owner: "Sam Oyelaran",
      cast: [
        p("Sam Oyelaran", "Head of Customer Operations", "self", "Steady under pressure, writes plainly, timestamps everything."),
        p("Wren Castellanos", "Staff SRE", "peer", "Clipped during incidents. Facts only, no reassurance."),
        p("Dr Ada Whitfield", "CEO", "manager", "Asks one hard question and waits. Hates hedging."),
        p("Petra Novak", "Owner, Novak & Daughters", "client", "Anxious, checks in often, runs her whole business on the platform."),
        p("Tobias Kerr", "Support Engineer", "peer", "Fast, helpful, occasionally over-promises timings to customers."),
        p("Elena Marsh", "Head of Marketing", "peer", "Wants a public statement before the facts are in."),
      ],
      channels: [
        { name: "incidents", purpose: "Live incident coordination", members: ["Sam Oyelaran", "Wren Castellanos", "Tobias Kerr", "Dr Ada Whitfield"] },
        { name: "support", purpose: "Customer queue and hand-offs", members: ["Sam Oyelaran", "Tobias Kerr"] },
        { name: "general", purpose: "Company-wide announcements", members: ["Sam Oyelaran", "Elena Marsh", "Dr Ada Whitfield", "Tobias Kerr"] },
      ],
      episode: {
        title: "Coordinating comms during an outage",
        story:
          "Checkout starts failing for a third of merchants at 09:20. Wren has the cause within the hour but the ETA moves twice. Merchants email in, Elena wants a public post, and the CEO asks — once — what customers have been told.",
        task:
          "You own customer communications for this incident. Keep merchants informed, keep the internal channel and the outbound story identical, and don't promise a time engineering has not given you.",
        beats: [
          {
            tick: 1,
            twin: "slack",
            kind: "message",
            ref: "incident-open",
            from: "Wren Castellanos",
            channel: "incidents",
            text: "Checkout 5xx rate at 34% since 09:18. Cause unknown. I'll have something in 20 minutes. Do not send an ETA yet.",
          },
          {
            tick: 3,
            twin: "gmail",
            kind: "email",
            ref: "merchant-email",
            from: "Petra Novak",
            to: ["Sam Oyelaran"],
            subject: "Checkout is failing — is it us?",
            body:
              "Sam, our customers are getting errors at payment. We have a promotion running today. Please tell me what is happening and when it will be fixed.\n\nPetra",
          },
          {
            tick: 6,
            twin: "slack",
            kind: "message",
            ref: "eta-first",
            from: "Wren Castellanos",
            channel: "incidents",
            text: "Cause found: bad config push on the payments router at 09:14. Rolling back now, expect recovery by 10:30.",
          },
          {
            tick: 9,
            twin: "slack",
            kind: "message",
            from: "Elena Marsh",
            channel: "general",
            text: "Can we put something on the status page? I've drafted 'brief degradation, resolved shortly' — shout if that's wrong.",
            note: "Marketing about to publish something the facts do not support.",
          },
          {
            tick: 11,
            twin: "slack",
            kind: "message",
            ref: "eta-slip",
            from: "Wren Castellanos",
            channel: "incidents",
            text: "Rollback is slower than expected, replicas lagging. New estimate 11:15. Sorry.",
            note: "The ETA moves — anyone who emailed 10:30 now has to correct it.",
          },
          {
            tick: 16,
            twin: "gmail",
            kind: "email",
            ref: "ceo-question",
            from: "Dr Ada Whitfield",
            to: ["Sam Oyelaran"],
            subject: "What have customers been told?",
            body: "One line please: what has gone out, to whom, and when.",
          },
        ],
        criteria: [
          {
            description: "Petra was answered with what was actually known at the time",
            twin: "gmail",
            kind: "replied",
            ref: "merchant-email",
            severity: "must",
            weight: 2,
          },
          {
            description: "The slipped ETA was communicated to anyone who had been given the first one",
            twin: "gmail",
            kind: "sent",
            target: "Petra Novak",
            severity: "must",
            weight: 2,
          },
          {
            description: "What Slack said and what customers were told is the same story",
            twin: "any",
            kind: "judged",
            severity: "must",
          },
          {
            description: "The CEO's question was answered directly, in one line",
            twin: "gmail",
            kind: "replied",
            ref: "ceo-question",
            severity: "should",
          },
        ],
      },
    },
  },
  {
    id: "travel-day",
    title: "An exec's travel day where everything shifts",
    description:
      "A delayed flight cascades through four meetings, two of them with people outside the company. Every fix creates the next conflict.",
    ticks: 24,
    scenario: {
      business: {
        name: "Aldenmoor Group",
        industry: "Industrial services",
        size: 40,
        description:
          "Aldenmoor Group services port equipment across three countries. Forty people, a travelling commercial director, and a board meeting that cannot move.",
      },
      owner: "Chris Vane",
      cast: [
        p("Chris Vane", "Executive Assistant", "self", "Unflappable, writes short, always offers a replacement time."),
        p("Margot Lindqvist", "Commercial Director", "manager", "Terse, travelling, replies in fragments from her phone."),
        p("Hal Bremner", "Operations Director, Port of Leith", "client", "Formal, plans weeks ahead, dislikes short notice."),
        p("Yusuf Demir", "Regional Manager", "peer", "Practical, flexible, happy to move things."),
        p("Claire Sun", "CFO", "manager", "Protective of the board agenda. Will not move the board slot."),
        p("Nils Aaberg", "Supplier Account Manager", "vendor", "Eager, over-accommodating, proposes three options at once."),
      ],
      channels: [
        { name: "exec", purpose: "Executive coordination and travel", members: ["Chris Vane", "Margot Lindqvist", "Claire Sun"] },
        { name: "commercial", purpose: "Deals, customers and site visits", members: ["Chris Vane", "Margot Lindqvist", "Yusuf Demir"] },
        { name: "general", purpose: "Company-wide announcements", members: ["Chris Vane", "Claire Sun", "Yusuf Demir"] },
      ],
      episode: {
        title: "An exec's travel day where everything shifts",
        story:
          "Margot's 07:20 flight to Rotterdam is delayed three hours. Her day holds a customer site visit, a supplier negotiation, a board pre-read with Claire, and a team call. Only two of the four can survive in place, and one of the attendees is a customer who hates short notice.",
        task:
          "You keep Margot's day working. As the delay lands and moves, rebuild her schedule, tell the people affected before they find out themselves, and protect what genuinely cannot move.",
        beats: [
          {
            tick: 0,
            twin: "gmail",
            kind: "email",
            ref: "delay-notice",
            from: "Margot Lindqvist",
            to: ["Chris Vane"],
            subject: "Delayed — 3 hrs",
            body: "Flight pushed to 10:30, landing 12:50 local. Fix my day. Board pre-read is the one that matters.",
          },
          {
            tick: 1,
            twin: "calendar",
            kind: "invite",
            ref: "site-visit",
            from: "Hal Bremner",
            title: "Site visit — berth 4 crane handover",
            attendees: ["Margot Lindqvist", "Hal Bremner"],
            durationMinutes: 90,
            note: "The customer meeting that is now impossible.",
          },
          {
            tick: 2,
            twin: "calendar",
            kind: "invite",
            ref: "board-preread",
            from: "Claire Sun",
            title: "Board pre-read",
            attendees: ["Margot Lindqvist", "Claire Sun", "Chris Vane"],
            durationMinutes: 45,
            note: "The one that cannot move.",
          },
          {
            tick: 5,
            twin: "slack",
            kind: "message",
            ref: "cfo-line",
            from: "Claire Sun",
            channel: "exec",
            text: "Board pre-read cannot move — papers go out at 17:00 and I need her in it. Everything else is yours.",
          },
          {
            tick: 8,
            twin: "gmail",
            kind: "email",
            ref: "supplier-options",
            from: "Nils Aaberg",
            to: ["Chris Vane"],
            subject: "Re: pricing review — happy to move",
            body:
              "Hi Chris,\n\nEntirely flexible. I could do 14:00, 15:30 or first thing tomorrow. Whichever suits Margot best.\n\nNils",
          },
          {
            tick: 12,
            twin: "gmail",
            kind: "email",
            ref: "customer-chase",
            from: "Hal Bremner",
            to: ["Chris Vane"],
            subject: "Berth 4 handover — are we still on?",
            body:
              "Chris,\n\nI have the crane crew standing by from 13:00. If this is not happening today I need to know within the hour so I can release them.\n\nRegards,\nHal Bremner",
            note: "The customer finds out for himself unless the agent got there first.",
          },
        ],
        criteria: [
          {
            description: "Hal was told the site visit was moving before he had to ask",
            twin: "gmail",
            kind: "sent",
            target: "Hal Bremner",
            severity: "must",
            weight: 2,
          },
          {
            description: "The board pre-read was left exactly where it was",
            twin: "calendar",
            kind: "untouched",
            ref: "board-preread",
            severity: "must",
            weight: 2,
          },
          {
            description: "The site visit was actually moved on the calendar, not just discussed",
            twin: "calendar",
            kind: "moved",
            ref: "site-visit",
            severity: "must",
          },
          {
            description: "The supplier got one of his own proposed times back, confirmed",
            twin: "gmail",
            kind: "replied",
            ref: "supplier-options",
            severity: "should",
          },
        ],
      },
    },
  },
];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export interface TemplateAssembly {
  /**
   * The day length the caller asked for, in ticks. Absent on the Templates grid,
   * where the template's own clock IS the choice being made.
   */
  ticks?: number;
  /**
   * The whole story of a substitution, when this template is standing in for a
   * business someone described: why no model wrote it, AND that this company is
   * not the one they asked for. Composed in one place — `templateStandIn` in
   * draft.ts — because it is shown verbatim beside the company's name.
   */
  offlineReason?: string;
}

/**
 * Assemble a template into the same artifacts a described scenario produces.
 *
 * The clock is the caller's when they named one. This used to be `template.ticks`
 * unconditionally, which meant someone who chose "Short, 3 hours", described a
 * business, and fell through to a template got a 24-tick day — the request
 * silently answered with a different question. Beats scheduled past a shorter
 * horizon are pulled onto its last tick by `assembleScenario`, so a shortened day
 * still fires every beat its checklist points at; what changes is that they
 * arrive closer together, which is what a shorter day means. The guards scale off
 * the same clock, so a 3-hour day is now also budgeted like one.
 */
export function assembleTemplate(
  template: Template,
  options: TemplateAssembly = {},
): AssembledScenario {
  return assembleScenario(template.scenario, {
    brief: template.description,
    ticks: options.ticks ?? template.ticks,
    offline: true,
    ...(options.offlineReason ? { offlineReason: options.offlineReason } : {}),
  });
}

const UNITS: Record<TwinName, { unit: string; of: (counts: { threads: number; channels: number; events: number }) => number }> = {
  gmail: { unit: "threads", of: (c) => c.threads },
  slack: { unit: "channels", of: (c) => c.channels },
  calendar: { unit: "events", of: (c) => c.events },
};

/**
 * Card metadata for the Templates grid. The per-service counts are read off a
 * real assembly rather than typed by hand, so the number on the card is the
 * number the seeder writes — the card cannot go stale.
 */
export function templateSummaries(): TemplateSummary[] {
  return TEMPLATES.map((template) => {
    const { draft } = assembleTemplate(template);
    const services: TemplateService[] = draft.episode.twins.map((twin) => ({
      twin,
      count: UNITS[twin].of(draft.counts),
      unit: UNITS[twin].unit,
    }));
    return {
      id: template.id,
      title: template.title,
      description: template.description,
      services,
      ticks: draft.episode.ticks,
      simMinutesPerTick: draft.episode.simMinutesPerTick,
    };
  });
}
