// The world: one fake company, described once, projected into every twin.
//
// A WorldSeed is authored (or generated) before anything is seeded, and each
// twin's adapter reads the SAME seed. That is the whole point — see `Person`.

/** The three surfaces a Sonata world spans. */
export type TwinName = "gmail" | "slack" | "calendar";

export const TWIN_NAMES: readonly TwinName[] = ["gmail", "slack", "calendar"];

/** Sparse per-twin map. Used everywhere a run may touch only some surfaces. */
export type ByTwin<T> = Partial<Record<TwinName, T>>;

/**
 * A reference to a person: a `Person.id` from the cast, or — for someone outside
 * the company — a raw email address or Slack id. Beats name people by ref rather
 * than by address so the same beat plays on any surface.
 */
export type PersonRef = string;

/**
 * One human being in the cloned company.
 *
 * This is the object that makes the clone coherent: a person carries their Gmail
 * address, their Slack user id and their calendar identity (the same email) in a
 * single record, so "Priya Raman" in the inbox, "@priya" in #ops and the "Priya
 * Raman" on the 2pm invite are provably the same person. Every twin adapter
 * seeds from this one cast, and the director writes in this one `voice`. Without
 * a shared cast the three twins are three unrelated fixtures, and no episode can
 * ask an agent to connect them.
 */
export interface Person {
  /** Stable, human-readable id — the join key across all three twins. */
  id: string;
  name: string;
  /** Gmail address, and the calendar attendee identity. */
  email: string;
  /** Slack user id, e.g. "U01PRIYA". */
  slackUserId: string;
  /** Job title, e.g. "Head of Support". */
  role: string;
  /** How they stand to the mailbox owner: "manager", "peer", "client", "vendor". */
  relationship: string;
  /** Style notes the director writes in: sentence length, greeting, quirks, mood. */
  voice: string;
}

/** A Slack channel in the cloned company. */
export interface ChannelSeed {
  /** Slack channel id, e.g. "C01OPS". */
  id: string;
  /** Channel name without the leading `#`. */
  name: string;
  /** What the channel is for — drives the chatter the generator writes. */
  purpose: string;
  /** `Person.id` values; the mailbox owner is a member of anything they can read. */
  members: PersonRef[];
  isPrivate: boolean;
}

export interface Business {
  name: string;
  /** One paragraph: what it does, who it sells to, what state it is in this week. */
  description: string;
  industry: string;
  /** Headcount. The cast is a sample of it, not necessarily all of it. */
  size: number;
}

export interface WorldSeed {
  business: Business;
  /** The shared cast — see `Person` for why this is one list, not three. */
  cast: Person[];
  channels: ChannelSeed[];
  /** `Person.id` of the person whose accounts the agent operates. */
  mailboxOwner: PersonRef;
  /**
   * IANA zone for the whole company, e.g. "America/New_York". Optional: when it
   * is absent the UTC offset carried by `EpisodeSpec.clock.startISO` governs, and
   * everything stays deterministic either way.
   */
  timezone?: string;
}
