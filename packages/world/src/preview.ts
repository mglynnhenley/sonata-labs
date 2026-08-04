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
  const { world, gmail, slack, calendar } = generated;

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

  return {
    business: world.business.name,
    owner,
    people: world.cast.length,
    threads: gmail.threads.length,
    messages,
    channels: slack.channels.length,
    slackMessages,
    events: calendar.events.length,
    spanDays: Math.round(oldestMinutes / 1440),
    sentence:
      `${world.business.name}: ${plural(world.cast.length, "person", "people")} across ` +
      `${plural(gmail.threads.length, "email thread")} (${plural(messages, "message")}), ` +
      `${plural(slack.channels.length, "Slack channel")} (${plural(slackMessages, "message")}) ` +
      `and ${plural(calendar.events.length, "meeting")}. ` +
      `You are ${ownerPerson?.name ?? world.mailboxOwner}.`,
  };
}
