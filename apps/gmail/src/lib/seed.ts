import type { Database } from "better-sqlite3";
import { insertMessage } from "./store/messages";
import { setMeta } from "./store/meta";
import { buildPayload, computeSnippet, stripHtml } from "./gmail/mime";
import { newHexId } from "./gmail/ids";
import type { GmailMessage } from "./gmail/types";

// Synthetic mailbox so the API/UI can be developed and verified without a real
// Gmail account. Mirrors what the sync CLI would produce: full-format Message
// resources with labelIds stripped, plus label rows and profile meta.

const PROFILE_EMAIL = "sandbox.user@gmail.com";

// Anchor to a fixed base so seeds are reproducible run-to-run.
const BASE = Date.UTC(2026, 6, 28, 9, 0, 0); // 2026-07-28T09:00:00Z
const HOUR = 3600_000;
const DAY = 24 * HOUR;

interface SeedMsg {
  from: string;
  to?: string;
  subject: string;
  minutesAgo: number; // offset back from BASE
  text?: string;
  html?: string;
  labels: string[];
  threadKey?: string; // messages sharing a threadKey are one thread
  replyToKey?: string; // ties a reply to an earlier message's rfc822 id
}

const ME = `Sandbox User <${PROFILE_EMAIL}>`;

const SEED: SeedMsg[] = [
  {
    from: "GitHub <notifications@github.com>",
    subject: "[acme/web] Re: Flaky test in checkout flow (#4821)",
    minutesAgo: 35,
    text: "matilda commented: I can reproduce this locally when the network is throttled. Looks like a race between the cart hydration and the price fetch. Assigning to myself.",
    labels: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_UPDATES"],
    threadKey: "gh-4821",
  },
  {
    from: "GitHub <notifications@github.com>",
    subject: "[acme/web] Re: Flaky test in checkout flow (#4821)",
    minutesAgo: 12,
    text: "priya commented: Nice find. Let's gate the price fetch behind the hydration promise and add a regression test. Can you open a PR today?",
    labels: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_UPDATES"],
    threadKey: "gh-4821",
    replyToKey: "gh-4821",
  },
  {
    from: "Linear <notifications@linear.app>",
    subject: "You were assigned ACM-1290 “Ship sandbox reset endpoint”",
    minutesAgo: 90,
    text: "Priya assigned you a new issue in the Platform team. Priority: High. Due: Friday. Open in Linear to see the full description and sub-tasks.",
    labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
  },
  {
    from: "Stripe <receipts@stripe.com>",
    subject: "Your receipt from Acme Inc. [#2049-3387]",
    minutesAgo: 240,
    html: "<div style='font-family:Arial'><h2>Receipt</h2><p>Amount paid: <b>$49.00</b></p><p>Thanks for your business. This receipt is for your records.</p></div>",
    labels: ["INBOX", "CATEGORY_UPDATES", "Label_3"],
  },
  {
    from: "Notion <team@makenotion.com>",
    subject: "Your weekly digest: 3 pages updated",
    minutesAgo: 300,
    html: "<div style='font-family:Helvetica'><h3>This week in your workspace</h3><ul><li>Roadmap Q3 — edited by Priya</li><li>Design specs — 4 comments</li><li>Onboarding — new sub-page</li></ul></div>",
    labels: ["INBOX", "CATEGORY_UPDATES"],
  },
  {
    from: "Priya Nair <priya@acme.co>",
    subject: "Lunch tomorrow?",
    minutesAgo: 420,
    text: "Are you free around 12:30? Thinking the new ramen place near the office. Let me know and I'll book a table for us.",
    labels: ["INBOX", "UNREAD", "STARRED", "CATEGORY_PERSONAL"],
    threadKey: "lunch",
  },
  {
    from: ME,
    to: "Priya Nair <priya@acme.co>",
    subject: "Re: Lunch tomorrow?",
    minutesAgo: 400,
    text: "Yes! 12:30 works. Ramen sounds perfect — let's do it. I'll head down from the 4th floor.",
    labels: ["SENT", "CATEGORY_PERSONAL"],
    threadKey: "lunch",
    replyToKey: "lunch",
  },
  {
    from: "LinkedIn <messages-noreply@linkedin.com>",
    subject: "You have 4 new notifications this week",
    minutesAgo: 600,
    html: "<div style='font-family:Arial'><p>Your post about SQLite got <b>1,204</b> impressions.</p><p>3 people viewed your profile.</p></div>",
    labels: ["INBOX", "CATEGORY_SOCIAL"],
  },
  {
    from: "Amazon.com <ship-confirm@amazon.com>",
    subject: "Your package has shipped",
    minutesAgo: 60 * 20,
    html: "<div style='font-family:Arial'><h3>Arriving Tuesday</h3><p>USB-C cable (2-pack) and mechanical keyboard.</p><p>Track your package for the latest updates.</p></div>",
    labels: ["INBOX", "CATEGORY_UPDATES", "Label_3"],
  },
  {
    from: "The Verge <newsletter@theverge.com>",
    subject: "The morning after: everything announced today",
    minutesAgo: 60 * 26,
    html: "<div style='font-family:Georgia'><h2>Today's biggest stories</h2><p>New laptops, a foldable, and a surprise pricing change. Here's the rundown.</p></div>",
    labels: ["INBOX", "CATEGORY_PROMOTIONS"],
  },
  {
    from: "Priya Nair <priya@acme.co>",
    subject: "Q3 planning doc — needs your review",
    minutesAgo: 60 * 30,
    text: "I dropped the Q3 planning doc in the shared drive. Can you review the platform section before Thursday's sync? Mostly want a gut check on the sandbox milestones.",
    labels: ["INBOX", "STARRED", "IMPORTANT", "Label_1", "CATEGORY_PERSONAL"],
  },
  {
    from: "Figma <no-reply@figma.com>",
    subject: "Priya invited you to “Sandbox UI” ",
    minutesAgo: 60 * 33,
    html: "<div style='font-family:Arial'><p>Priya invited you to edit <b>Sandbox UI</b>.</p><p>Open the file to start collaborating.</p></div>",
    labels: ["INBOX", "CATEGORY_UPDATES"],
  },
  {
    from: "Booking.com <noreply@booking.com>",
    subject: "Your trip to Lisbon is coming up",
    minutesAgo: 60 * 40,
    html: "<div style='font-family:Arial'><h3>See you soon in Lisbon</h3><p>Check-in: Friday. Here are directions and check-in details for your stay.</p></div>",
    labels: ["INBOX", "Label_2", "CATEGORY_UPDATES"],
  },
  {
    from: "Google <no-reply@accounts.google.com>",
    subject: "Security alert: new sign-in on Mac",
    minutesAgo: 60 * 48,
    text: "Your Google Account was just signed in to on a new Mac device. If this was you, no action is needed. If not, secure your account.",
    labels: ["INBOX", "IMPORTANT", "CATEGORY_UPDATES"],
  },
  {
    from: "Spotify <no-reply@spotify.com>",
    subject: "Your 2026 Wrapped is almost here",
    minutesAgo: 60 * 55,
    html: "<div style='font-family:Circular,Arial'><h2>Get ready</h2><p>You listened to a LOT this year. Your Wrapped drops soon.</p></div>",
    labels: ["CATEGORY_PROMOTIONS"],
  },
  {
    from: "Old Newsletter <hello@oldnews.example>",
    subject: "We miss you — 30% off to come back",
    minutesAgo: 60 * 70,
    html: "<div>Come back and save 30%. Limited time offer.</div>",
    labels: ["TRASH"],
  },
  {
    from: "Sketchy Deals <win@totally-legit.example>",
    subject: "You've WON a $1000 gift card!!!",
    minutesAgo: 60 * 80,
    html: "<div>Click here to claim your prize now!!!</div>",
    labels: ["SPAM"],
  },
  {
    from: "Calendar <calendar-notification@google.com>",
    subject: "Reminder: Design review at 3:00 PM",
    minutesAgo: 60 * 5,
    text: "This is a reminder for Design review at 3:00 PM in Meet. Agenda: sandbox message list, thread view, activity panel.",
    labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
  },
];

interface LabelSpec {
  id: string;
  name: string;
  type: "system" | "user";
  color?: { textColor: string; backgroundColor: string };
}

const LABELS: LabelSpec[] = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "DRAFT", name: "DRAFT", type: "system" },
  { id: "TRASH", name: "TRASH", type: "system" },
  { id: "SPAM", name: "SPAM", type: "system" },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "CATEGORY_PERSONAL", name: "CATEGORY_PERSONAL", type: "system" },
  { id: "CATEGORY_SOCIAL", name: "CATEGORY_SOCIAL", type: "system" },
  { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
  { id: "CATEGORY_UPDATES", name: "CATEGORY_UPDATES", type: "system" },
  { id: "CATEGORY_FORUMS", name: "CATEGORY_FORUMS", type: "system" },
  {
    id: "Label_1",
    name: "Work",
    type: "user",
    color: { textColor: "#ffffff", backgroundColor: "#16a765" },
  },
  {
    id: "Label_2",
    name: "Travel",
    type: "user",
    color: { textColor: "#ffffff", backgroundColor: "#4986e7" },
  },
  {
    id: "Label_3",
    name: "Receipts",
    type: "user",
    color: { textColor: "#ffffff", backgroundColor: "#f691b3" },
  },
];

function rfc822IdFor(key: string): string {
  return `<${key}@mail.sandbox.local>`;
}

export function seedDatabase(db: Database): void {
  const insertLabel = db.prepare(
    `INSERT OR REPLACE INTO labels (id, name, type, message_list_visibility, label_list_visibility, color_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const l of LABELS) {
    insertLabel.run(
      l.id,
      l.name,
      l.type,
      l.type === "system" && ["TRASH", "SPAM", "DRAFT"].includes(l.id) ? "hide" : "show",
      "labelShow",
      l.color ? JSON.stringify(l.color) : null,
    );
  }

  setMeta(db, "profile_email", PROFILE_EMAIL);

  // Assign one thread id per threadKey; standalone messages get their own.
  const threadIds = new Map<string, string>();
  const rfc822ByKey = new Map<string, string>();
  let history = 1000;

  const seed = db.transaction(() => {
    // Insert oldest-first so reply threading can reference earlier ids.
    const ordered = [...SEED].sort((a, b) => b.minutesAgo - a.minutesAgo);
    for (const m of ordered) {
      const id = newHexId();
      const threadKey = m.threadKey ?? `single-${id}`;
      if (!threadIds.has(threadKey)) threadIds.set(threadKey, newHexId());
      const threadId = threadIds.get(threadKey)!;

      const internalDate = BASE - m.minutesAgo * 60_000;
      const bodyText = m.text ?? stripHtml(m.html ?? "");
      const rfc822MessageId = rfc822IdFor(`${threadKey}-${id}`);
      if (m.threadKey && !rfc822ByKey.has(m.threadKey)) {
        rfc822ByKey.set(m.threadKey, rfc822MessageId);
      }
      const inReplyTo = m.replyToKey ? rfc822ByKey.get(m.replyToKey) ?? null : null;

      history += 1;
      const to = m.to ?? ME;
      const payload = buildPayload({
        from: m.from,
        to,
        subject: m.subject,
        date: new Date(internalDate),
        messageId: rfc822MessageId,
        inReplyTo: inReplyTo ?? undefined,
        text: m.text,
        html: m.html,
      });

      const sizeEstimate = (m.text ?? m.html ?? "").length + m.subject.length + 200;
      const resource: GmailMessage = {
        id,
        threadId,
        snippet: computeSnippet(bodyText),
        historyId: String(history),
        internalDate: String(internalDate),
        sizeEstimate,
        payload,
      };

      insertMessage(db, {
        id,
        threadId,
        internalDate,
        historyId: history,
        sizeEstimate,
        snippet: computeSnippet(bodyText),
        subject: m.subject,
        fromAddr: m.from,
        toAddrs: to,
        rfc822MessageId,
        inReplyTo,
        hasAttachment: false,
        bodyText,
        rawJson: JSON.stringify(resource),
        isSandboxCreated: false,
        labelIds: m.labels,
      });
    }

    setMeta(db, "history_counter", String(history));
  });

  seed();
}
