// Example briefs for the new-scenario box. They are one click, not decoration:
// a first-time user should be able to press one and see a whole company appear
// without having thought of a business first.
//
// Each is written the way the generator reads best — a company, a moment it is
// in, and one thing that goes wrong today.

export interface BriefExample {
  /** Two or three words for the chip. */
  label: string;
  /** What lands in the box. */
  text: string;
}

export const BRIEF_EXAMPLES: readonly BriefExample[] = [
  {
    label: "Fintech, audit week",
    text: "A 12-person fintech the week before its SOC 2 audit. This morning the auditor asks for evidence nobody has gathered, and the head of engineering is on a plane.",
  },
  {
    label: "Agency, quarter end",
    text: "A 20-person design agency on the last day of the quarter. Three invoices are unpaid, one client is disputing scope, and finance needs an answer before close of business.",
  },
  {
    label: "Hiring a candidate",
    text: "A Series A health startup trying to get a staff engineer candidate through a final loop this week. Two interviewers are double-booked and the candidate has a competing offer expiring Friday.",
  },
  {
    label: "Outage comms",
    text: "A B2B analytics company whose API has been degraded since 8am. Support is drowning, the status page is stale, and the biggest customer has just emailed the CEO directly.",
  },
  {
    label: "Exec travel day",
    text: "A 40-person logistics firm whose COO is flying to a customer site today. Her flight is delayed, two meetings need moving, and a supplier wants a decision before she lands.",
  },
];
