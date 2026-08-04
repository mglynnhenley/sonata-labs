import type { EpisodeSpec, WorldSeed } from "@sonata/core";
import { owner } from "@sonata/core";
import {
  canonicalize,
  narrateSurfaces,
  type GeneratedWorld,
  type SlackSeed,
  type WorldDraft,
} from "@sonata/world";
import type { WorldCounts } from "../../../app/api/_lib/types";

// Growing the company's PAST, once the day has been written.
//
// The scenario draft says who exists and what happens today; this says what
// happened before nine o'clock. Without it a "cloned business" is an empty
// mailbox with a cast list attached, and every criterion about finding a fact on
// another surface is trivially unanswerable — there is nothing there to find.
//
// It runs as a second pass, against the cast the day was already written for,
// rather than as its own generation: two generators would give the same brief
// two different companies, and the whole product is that they are one.

/** `narrateSurfaces` reads `business` and the cast; `people` is carried so the
 *  draft is a whole WorldDraft rather than a convincing-looking partial. */
function draftFrom(seed: WorldSeed): WorldDraft {
  const me = owner(seed);
  return {
    business: seed.business,
    people: seed.cast.map((p) => ({
      name: p.name,
      role: p.role,
      relationship: p.relationship,
      voice: p.voice,
      org: seed.business.name,
    })),
    mailboxOwnerName: me.name,
    timezone: seed.timezone ?? "UTC",
  };
}

/**
 * Every channel the day needs, present in the backlog whether or not the model
 * remembered it. A beat posts into "#ops" by name, so a channel the narrative
 * pass skipped is a beat that cannot land — and `canonicalize` rebuilds the
 * world's channel list from this seed, so a channel missing here is a channel
 * missing from the world.
 */
function withEveryChannel(slack: SlackSeed, seed: WorldSeed): SlackSeed {
  const written = new Set(slack.channels.map((c) => c.name));
  const missing = seed.channels
    .filter((c) => !written.has(c.name))
    .map((c) => ({
      name: c.name,
      topic: c.purpose,
      purpose: c.purpose,
      members: c.members,
      messages: [],
    }));
  return missing.length === 0 ? slack : { channels: [...slack.channels, ...missing] };
}

/** What the clone actually contains, counted off the seeds rather than guessed. */
export function actualCounts(clone: GeneratedWorld): WorldCounts {
  return {
    people: clone.world.cast.length,
    threads: clone.gmail.threads.length,
    messages: clone.gmail.threads.reduce((n, t) => n + t.messages.length, 0),
    channels: clone.slack.channels.length,
    slackMessages: clone.slack.channels.reduce(
      (n, c) =>
        n + c.messages.reduce((m, msg) => m + 1 + (msg.threadReplies?.length ?? 0), 0),
      0,
    ),
    events: clone.calendar.events.length,
  };
}

export interface BacklogOptions {
  model?: string;
  say?: (msg: string) => void;
}

/**
 * The days behind this one, on all three surfaces at once.
 *
 * Returns the canonicalized clone, whose `world` — not the one passed in — is
 * the one to save and run: `canonicalize` re-derives the channel list from the
 * Slack backlog, so the two would otherwise disagree about who is in #ops.
 */
export async function growBacklog(
  spec: EpisodeSpec,
  brief: string,
  opts: BacklogOptions = {},
): Promise<GeneratedWorld> {
  const seed = spec.world;
  const draft = draftFrom(seed);
  const seeds = await narrateSurfaces(brief, draft, seed.cast, seed.mailboxOwner, {
    ...(opts.model ? { model: opts.model } : {}),
    channels: seed.channels.map((c) => c.name),
  });

  return canonicalize({
    id: spec.id,
    description: brief,
    generatedAtISO: new Date().toISOString(),
    world: seed,
    gmail: seeds.gmail,
    slack: withEveryChannel(seeds.slack, seed),
    calendar: seeds.calendar,
  });
}
