import type { GeneratedWorld } from "./generate";

// The dashboard's preview step: after a clone is generated but before it is
// pushed into the twins, the user sees exactly what they are about to get. Pure
// counting over the generated seeds — no twin has to be running, and no model
// call is made, so a template previews instantly.

export interface WorldPreview {
  /** Company name and the cast size, for the card heading. */
  business: string;
  /** `"Priya Raman — Chief of Staff"`, the identity the agent will operate as. */
  owner: string;
  people: number;
  threads: number;
  /** Individual emails across every thread. */
  messages: number;
  channels: number;
  /** Slack messages including threaded replies. */
  slackMessages: number;
  events: number;
  /** CRM records across companies, contacts and deals — the pipeline's size. */
  records: number;
  documents: number;
  campaigns: number;
  /** LinkedIn posts, drafts included: a draft is a post somebody has to decide about. */
  posts: number;
  /** How far back the oldest seeded item sits, in days. Rounded, 0 for today. */
  spanDays: number;
  /** One line a person can read without decoding the numbers. */
  sentence: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Counts + a sentence. Pure; safe to call on a template or a fresh generation. */
export function previewWorld(generated: GeneratedWorld): WorldPreview {
  const { world, gmail, slack, calendar, attio, googleDocs, googleAds, linkedin } = generated;

  const messages = gmail.threads.reduce((n, t) => n + t.messages.length, 0);
  const slackMessages = slack.channels.reduce(
    (n, c) => n + c.messages.reduce((m, msg) => m + 1 + (msg.threadReplies?.length ?? 0), 0),
    0,
  );

  // The span is what tells a user this is a lived-in company rather than a
  // fixture minted five minutes ago, so it is worth showing next to the counts.
  const oldestMinutes = Math.max(
    0,
    ...gmail.threads.flatMap((t) => t.messages.map((m) => m.minutesAgo)),
    ...slack.channels.flatMap((c) =>
      c.messages.flatMap((m) => [m.minutesAgo, ...(m.threadReplies ?? []).map((r) => r.minutesAgo)]),
    ),
    ...calendar.events.map((e) => Math.max(0, -e.startOffsetMin)),
  );

  const ownerPerson = world.cast.find((p) => p.id === world.mailboxOwner) ?? world.cast[0];
  const owner = ownerPerson ? `${ownerPerson.name} — ${ownerPerson.role}` : world.mailboxOwner;

  const records = attio.companies.length + attio.contacts.length + attio.deals.length;
  const documents = googleDocs.documents.length;
  const campaigns = googleAds.campaigns.length;
  const posts = linkedin.posts.length;

  // The four later surfaces get their own sentence, and only when the world
  // actually carries them: a company that runs no advertising is a real world,
  // and "0 campaigns" on the screen where somebody decides whether to seed reads
  // as a generator that failed rather than as a business that does not advertise.
  const alsoHas = [
    records ? plural(records, "CRM record") : "",
    documents ? plural(documents, "document") : "",
    campaigns ? plural(campaigns, "ad campaign") : "",
    posts ? plural(posts, "LinkedIn post") : "",
  ].filter(Boolean);

  return {
    business: world.business.name,
    owner,
    people: world.cast.length,
    threads: gmail.threads.length,
    messages,
    channels: slack.channels.length,
    slackMessages,
    events: calendar.events.length,
    records,
    documents,
    campaigns,
    posts,
    spanDays: Math.round(oldestMinutes / 1440),
    sentence:
      `${world.business.name}: ${plural(world.cast.length, "person", "people")} across ` +
      `${plural(gmail.threads.length, "email thread")} (${plural(messages, "message")}), ` +
      `${plural(slack.channels.length, "Slack channel")} (${plural(slackMessages, "message")}) ` +
      `and ${plural(calendar.events.length, "meeting")}. ` +
      (alsoHas.length ? `Also ${alsoHas.join(", ")}. ` : "") +
      `You are ${ownerPerson?.name ?? world.mailboxOwner}.`,
  };
}
