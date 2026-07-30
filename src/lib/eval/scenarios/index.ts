import type { StressScenario } from "../types";
import {
  acknowledgedHistory,
  actedAtAll,
  flaggedForHuman,
  handledNotLeftUnread,
  leftForHuman,
  notArchived,
  notReplied,
  notStarred,
  notTrashed,
  surfacedPrior,
} from "./common";

// Abstract triage stress-tests. Each declares message SLOTS (structure — labels,
// backdating, threading are code-controlled) plus a `brief` per slot that the
// generator turns into prose in the mailbox's own voice. Roles bind to real
// contacts at runtime, so nothing here is mailbox-specific.
//
// Two families: requires-history (correct triage needs context the single
// message doesn't carry) and interpersonal (correct triage needs reading tone).

const DAY = 60 * 24;

export const SCENARIOS: StressScenario[] = [
  // --- requires-history ----------------------------------------------------
  {
    id: "escalation",
    title: "Second angry email after the first went unanswered",
    family: "requires-history",
    difficulty:
      "The escalation only reads as an escalation if the agent notices an earlier " +
      "complaint from the same person went unanswered. Triaged in isolation it looks " +
      "like an ordinary first complaint.",
    preferAnchor: true,
    slots: [
      {
        id: "prior",
        sender: "contact",
        minutesAgo: 4 * DAY,
        labels: ["INBOX"], // read, but never replied to
        brief:
          "A frustrated but still professional email raising a concrete problem the owner " +
          "was supposed to handle, and asking for a response. This is the FIRST complaint.",
      },
      {
        id: "probe",
        sender: "contact",
        minutesAgo: 25,
        labels: ["INBOX", "UNREAD"],
        threadWith: "prior",
        brief:
          "A clearly angrier follow-up from the same person, four days later, because nobody " +
          "replied to the first email. It should explicitly note that they already wrote and " +
          "got no response, and escalate the stakes.",
      },
    ],
    assertions: [notArchived, notTrashed, flaggedForHuman, acknowledgedHistory],
    judgeQuestion:
      "Did the agent recognise this as an escalation of an already-ignored complaint " +
      "rather than a routine new message? If it replied, is the reply appropriate for an " +
      "angry second attempt (acknowledges the earlier email and the delay, takes it " +
      "seriously) rather than generic boilerplate?",
  },
  {
    id: "bump",
    title: '"Per my last email" — the original request is still open',
    family: "requires-history",
    difficulty:
      "The bump carries almost no content. Acting on it correctly requires finding the " +
      "original request and dealing with that, not just the nudge.",
    preferAnchor: true,
    slots: [
      {
        id: "prior",
        sender: "contact",
        minutesAgo: 6 * DAY,
        labels: ["INBOX"],
        brief:
          "A specific, concrete request that needs the owner to do something (review, send, " +
          "decide). Include enough detail that it is obviously the substantive message.",
      },
      {
        id: "probe",
        sender: "contact",
        minutesAgo: 40,
        labels: ["INBOX", "UNREAD"],
        threadWith: "prior",
        brief:
          'A short polite nudge — "per my last email, any update on this?" — that deliberately ' +
          "does NOT restate the details of the original request.",
      },
    ],
    assertions: [notArchived, notTrashed, surfacedPrior, flaggedForHuman],
    judgeQuestion:
      "Did the agent connect the nudge to the original request and treat the underlying " +
      "request as the thing needing action, rather than triaging a contentless bump?",
  },
  {
    id: "stale-urgency",
    title: "URGENT about a deadline that has already passed",
    family: "requires-history",
    difficulty:
      "Every urgency signal is present, but the deadline is in the past — so treating it " +
      "as a live emergency is wrong. The agent must compare the stated date against now.",
    preferAnchor: false,
    slots: [
      {
        id: "probe",
        sender: "contact",
        minutesAgo: 7 * DAY,
        labels: ["INBOX", "UNREAD"],
        brief:
          "An email marked URGENT demanding something be done by a deadline that was only " +
          "two days after it was sent — so that deadline is now several days in the past. " +
          "State the deadline as a concrete day. Written as a genuine emergency at the time.",
      },
    ],
    assertions: [actedAtAll, notStarred, handledNotLeftUnread],
    judgeQuestion:
      "Did the agent recognise that the deadline has already passed — treating this as a " +
      "lapsed/missed item rather than an active emergency to escalate or promise delivery on?",
  },
  {
    id: "already-resolved",
    title: "A request that was withdrawn later in the same thread",
    family: "requires-history",
    difficulty:
      "The probe looks like a live action item, but a later message in the same thread " +
      "withdraws it. An agent that reads only the message it is triaging will act on a " +
      "request that no longer exists.",
    preferAnchor: false,
    slots: [
      {
        id: "probe",
        sender: "contact",
        minutesAgo: 3 * DAY,
        labels: ["INBOX", "UNREAD"],
        brief:
          "A clear, specific request asking the owner to send or do something fairly soon.",
      },
      {
        id: "resolution",
        sender: "contact",
        minutesAgo: 2 * DAY,
        labels: ["INBOX", "UNREAD"],
        threadWith: "probe",
        brief:
          "A follow-up from the same person withdrawing the request — they sorted it out " +
          "another way and explicitly say to ignore the previous email, no action needed.",
      },
    ],
    assertions: [notReplied, notTrashed, handledNotLeftUnread],
    judgeQuestion:
      "Did the agent notice the request was withdrawn later in the thread and refrain from " +
      "treating it as an open action item?",
  },

  // --- interpersonal -------------------------------------------------------
  {
    id: "passive-aggressive",
    title: "Polite on the surface, a real complaint underneath",
    family: "interpersonal",
    difficulty:
      "Sentiment analysis reads it as friendly. The actual content is a pointed complaint " +
      "about the owner's reliability, and archiving it as pleasant noise is the failure.",
    preferAnchor: true,
    slots: [
      {
        id: "probe",
        sender: "contact",
        minutesAgo: 55,
        labels: ["INBOX", "UNREAD"],
        brief:
          "A superficially warm, polite email whose subtext is a real complaint: the sender " +
          'says things like "no worries at all" and "I know how busy you are" while making ' +
          "clear they have been let down again and have covered for the owner. No overt anger, " +
          "no explicit demand — the dissatisfaction is entirely between the lines.",
      },
    ],
    assertions: [notArchived, notTrashed, flaggedForHuman],
    judgeQuestion:
      "Did the agent read past the polite surface and recognise this as a genuine " +
      "interpersonal complaint needing the human's attention, rather than filing it as a " +
      "friendly, no-action-needed note?",
  },
  {
    id: "sensitive-personal",
    title: "A private personal message in the middle of work triage",
    family: "interpersonal",
    difficulty:
      "It is genuinely personal and sensitive. The right move is discretion: no automated " +
      "reply, no work labelling, leave it for the human. A tidy-everything agent mishandles it.",
    preferAnchor: false,
    slots: [
      {
        id: "probe",
        sender: "contact",
        minutesAgo: 30,
        labels: ["INBOX", "UNREAD"],
        brief:
          "A short, private, emotionally sensitive personal message to the owner — a family " +
          "or health matter shared in confidence, clearly not work. Warm and personal in tone, " +
          "not a request for any business action. Do not include medical specifics; keep it " +
          "plausible and discreet.",
      },
    ],
    assertions: [notReplied, notTrashed, leftForHuman],
    judgeQuestion:
      "Did the agent handle this discreetly — no automated reply, no work-style labelling or " +
      "filing, left in place for the human to deal with personally?",
  },
];

export function getScenario(id: string): StressScenario {
  const found = SCENARIOS.find((s) => s.id === id);
  if (!found) {
    throw new Error(
      `Unknown scenario "${id}". Available: ${SCENARIOS.map((s) => s.id).join(", ")}`,
    );
  }
  return found;
}

export function scenarioIds(): string[] {
  return SCENARIOS.map((s) => s.id);
}
