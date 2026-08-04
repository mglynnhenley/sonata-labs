// Wire contracts for /api/sandbox/*. This is the Slack twin's half of the engine
// contract: the episode engine POSTs one beat at a time to /inject, the world
// seeder POSTs a whole workspace to /seed, and the judge GETs /snapshot either
// side of the agent.
//
// Deliberately NOT typed against @sonata/core: a twin is a standalone app that
// must run (and be tested) with no orchestrator installed. The shapes below are
// structurally compatible with core's `SlackMessagePayload`, `InjectedRef` and
// `SlackSnapshot`, and that compatibility is the contract.

/**
 * A moment in simulated time. `atMs` wins when both are present; `atISO` is the
 * form a hand-authored spec uses. Never defaulted to `Date.now()` for a beat —
 * a message stamped with wall-clock time inside a simulated 9am makes the whole
 * day incoherent to the agent reading it.
 */
export interface SimTime {
  atMs?: number;
  atISO?: string;
}

// ---------------------------------------------------------------------------
// POST /api/sandbox/inject
// ---------------------------------------------------------------------------

interface InjectBase extends SimTime {
  /** Channel id ("C…"/"D…"/"G…") or channel name, with or without the `#`. */
  channel: string;
  /** User id ("U…") or handle. Must already exist: the author has to be real. */
  user: string;
}

export interface InjectMessageRequest extends InjectBase {
  kind: "message";
  text: string;
}

export interface InjectThreadReplyRequest extends InjectBase {
  kind: "thread_reply";
  text: string;
  /** `ts` of the thread root the reply lands on. */
  threadTs: string;
}

export interface InjectReactionRequest extends InjectBase {
  kind: "reaction";
  /** Emoji short name, with or without colons. */
  emoji: string;
  /** `ts` of the message being reacted to; `threadTs` is accepted as an alias. */
  ts?: string;
  threadTs?: string;
}

export type InjectRequest =
  | InjectMessageRequest
  | InjectThreadReplyRequest
  | InjectReactionRequest;

/** Structurally core's `InjectedRef`. For a reaction, `id` is the target's ts. */
export interface InjectedSlackEvent {
  twin: "slack";
  /** Slack `ts` — the message id. */
  id: string;
  /** Channel id. */
  containerId: string;
  threadTs?: string;
}

// ---------------------------------------------------------------------------
// POST /api/sandbox/seed — body is `{ twin: "slack", seed: SlackSeedSpec }`
//
// Mapping from a core `WorldSeed`, which is what the world seeder holds:
//   users    ← cast.map(p => ({ id: p.slackUserId, realName: p.name,
//                               email: p.email, title: p.role }))
//   channels ← channels, with `members` mapped from `Person.id` to slackUserId
//   self     ← the mailboxOwner's slackUserId
// ---------------------------------------------------------------------------

export interface SlackSeedUser {
  /** Slack user id — `Person.slackUserId`. */
  id: string;
  /** Handle without the `@`. Defaults to a slug of `realName`. */
  name?: string;
  realName: string;
  title?: string;
  email?: string;
  tz?: string;
  isBot?: boolean;
  isAdmin?: boolean;
  isOwner?: boolean;
}

export interface SlackSeedChannel {
  /** Channel id; minted when absent. */
  id?: string;
  name: string;
  topic?: string;
  purpose?: string;
  isPrivate?: boolean;
  /** User ids or handles. */
  members: string[];
  /** When the channel was created; defaults to a year before the first message. */
  createdAtMs?: number;
}

export interface SlackSeedMessage extends SimTime {
  /** Name this message so a later one can reply to it, mirroring `BeatMeta.ref`. */
  ref?: string;
  /** Channel id or name. */
  channel: string;
  /** User id or handle. */
  user: string;
  text: string;
  /** `ref` of an earlier message in this same spec — replies into its thread. */
  replyTo?: string;
  /** Emoji short names already on the message, by reacting user id or handle. */
  reactions?: Array<{ emoji: string; users: string[] }>;
}

export interface SlackSeedSpec {
  team?: { id?: string; name?: string; domain?: string };
  /** The workspace owner the agent operates as — user id or handle. */
  self: string;
  users: SlackSeedUser[];
  channels: SlackSeedChannel[];
  messages: SlackSeedMessage[];
  /**
   * Leave everything from this moment on unread for the owner; everything older
   * is marked read. Absent means the whole seeded history is read — so during
   * the run "unread" means "arrived today", which is the only reading of the
   * badge that tells the judge anything.
   */
  unreadFromMs?: number;
}

// ---------------------------------------------------------------------------
// POST /api/sandbox/seed — the world seeder's wire seed
//
// @sonata/world resolves a whole cloned company into one absolute, id-carrying
// body per twin and POSTs it as `{ twin: "slack", seed: SlackWireSeed }`.
// Nothing in it is relative and nothing needs looking up: user ids, channel
// ids, `ts` values and membership are all resolved before it reaches the wire,
// and this twin creates them verbatim. It mints no users of its own — a "Priya"
// invented here would not be the "Priya" in the inbox, which is the premise.
//
// Structurally @sonata/world's `SlackWireSeed`; not imported, for the same
// reason as everything else in this file.
// ---------------------------------------------------------------------------

/** The shared cast, narrowed to the fields this twin actually reads. */
export interface SeedWorldPerson {
  id: string;
  name: string;
  email: string;
  slackUserId: string;
  role: string;
}

export interface SeedWorld {
  business: { name: string };
  cast: SeedWorldPerson[];
  /** `Person.id` of the person whose accounts the agent operates. */
  mailboxOwner: string;
}

export interface SlackWireMessage {
  /** Slack's "seconds.micros" id, strictly increasing within a channel. */
  ts: string;
  userId: string;
  text: string;
  /** Parent's `ts` for a threaded reply, null for a top-level message. */
  threadTs: string | null;
}

export interface SlackWireChannel {
  id: string;
  name: string;
  topic: string;
  purpose: string;
  isPrivate: boolean;
  /** Slack user ids. */
  memberIds: string[];
  messages: SlackWireMessage[];
}

export interface SlackWireSeed {
  world: SeedWorld;
  /** The instant every relative offset in the source seed was resolved against. */
  nowISO: string;
  /** Make the seeded state the one `reset` returns to. */
  promoteToSnapshot: boolean;
  /** Slack user id of the person whose workspace session the agent uses. */
  ownerUserId: string;
  channels: SlackWireChannel[];
}

export interface SeedRequest {
  twin: "slack";
  seed: SlackSeedSpec | SlackWireSeed;
}

/**
 * The contract's response: `{ ok, counts }` and nothing else. `counts` is
 * free-form per twin and counts what was actually written, because it is what
 * the dashboard's clone step shows a user who is asking "did that work?".
 */
export interface SeedResult {
  ok: true;
  counts: { users: number; channels: number; messages: number };
}

// ---------------------------------------------------------------------------
// GET /api/sandbox/snapshot — structurally core's `SlackSnapshot`, widened with
// the fields an episode judge needs (topic, read cursor, text hash).
// ---------------------------------------------------------------------------

export interface SlackTwinSnapshot {
  twin: "slack";
  capturedAt: number;
  channels: Array<{
    id: string;
    name: string;
    topic: string;
    isPrivate: boolean;
    isArchived: boolean;
    memberCount: number;
    messageCount: number;
    /** The owner's read cursor, and what sits above it — did the agent read? */
    lastRead: string;
    unread: number;
  }>;
  messages: Array<{
    channelId: string;
    channelName: string;
    ts: string;
    user: string;
    /** Truncated to a digest; `textHash` covers the rest. */
    text: string;
    /** Short hash of the FULL text, so an edit past the cut is still visible. */
    textHash: string;
    threadTs?: string;
    replyCount: number;
    /** `"emoji:count"`, e.g. `"eyes:2"`. */
    reactions: string[];
  }>;
}
