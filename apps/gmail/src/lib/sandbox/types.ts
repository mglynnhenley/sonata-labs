// Wire contracts for /api/sandbox/*. This is the Gmail twin's half of the
// engine contract: the episode engine POSTs one beat at a time to /inject, the
// world seeder POSTs a whole company to /seed, and the judge GETs /snapshot
// either side of the agent.
//
// Deliberately NOT typed against @sonata/core: a twin is a standalone app that
// must run (and be tested) with no orchestrator installed. The shapes below are
// structurally compatible with core's `EmailPayload`, `InjectedRef` and
// `GmailSnapshot`, and that compatibility is the contract — see the mapping
// notes on each type.

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

/** Maps from core's `EmailPayload` (people already resolved to addresses). */
export interface InjectEmailRequest extends SimTime {
  kind: "email";
  from: string;
  to?: string | string[];
  cc?: string | string[];
  subject: string;
  body: string;
  /**
   * Land this on an existing thread: a Gmail thread id, or any message id in
   * it. The engine resolves a beat's `inReplyTo` ref to a real id first — the
   * twin knows nothing about beats.
   */
  threadRef?: string;
  /** Defaults to INBOX + UNREAD: an injected beat is mail that just arrived. */
  labels?: string[];
}

/** Structurally core's `InjectedRef`, plus what a Gmail caller can use. */
export interface InjectedEmail {
  twin: "gmail";
  /** Gmail message id. */
  id: string;
  /** Gmail thread id. */
  containerId: string;
  rfc822MessageId: string;
  historyId: number;
  internalDate: number;
}

// ---------------------------------------------------------------------------
// POST /api/sandbox/seed — body is `{ twin: "gmail", seed: GmailSeedSpec }`
// ---------------------------------------------------------------------------

export interface GmailSeedLabel {
  /** Opaque to agents; use Gmail's own ids for system labels. */
  id: string;
  name: string;
  type?: "system" | "user";
  color?: { textColor: string; backgroundColor: string };
}

export interface GmailSeedMessage extends SimTime {
  /**
   * Name this message so a later one can reply to it, and so the caller can map
   * its own refs onto the ids the twin minted. Mirrors `BeatMeta.ref`.
   */
  ref?: string;
  from: string;
  to?: string | string[];
  cc?: string | string[];
  subject: string;
  body: string;
  /** Labels by id or by name; unknown strings become new user labels. */
  labels?: string[];
  /** `ref` of an earlier message in this same spec — threads onto it. */
  inReplyTo?: string;
}

export interface GmailSeedSpec {
  /** The mailbox owner's address — `Person.email` of `WorldSeed.mailboxOwner`. */
  profileEmail: string;
  /** Extra labels beyond Gmail's system set, which is always created. */
  labels?: GmailSeedLabel[];
  messages: GmailSeedMessage[];
}

// ---------------------------------------------------------------------------
// POST /api/sandbox/seed — the world seeder's wire seed
//
// @sonata/world resolves a whole cloned company into one absolute, id-carrying
// body per twin and POSTs it as `{ twin: "gmail", seed: GmailWireSeed }`.
// Nothing in it is relative and nothing needs looking up: ids, addresses,
// dates and threading are all resolved before it reaches the wire, and this
// twin creates them verbatim. It invents no identities of its own — a "Priya"
// minted here would not be the "Priya" in #ops, which is the whole premise.
//
// Structurally @sonata/world's `GmailWireSeed`; not imported, for the same
// reason as everything else in this file.
// ---------------------------------------------------------------------------

/** The shared cast, narrowed to the fields this twin actually reads. */
export interface SeedWorldPerson {
  id: string;
  name: string;
  email: string;
}

export interface SeedWorld {
  cast: SeedWorldPerson[];
  /** `Person.id` of the person whose mailbox this is. */
  mailboxOwner: string;
}

export interface GmailWireMessage {
  id: string;
  /** RFC 822 `Message-ID`, so threading survives a round trip through MIME. */
  messageIdHeader: string;
  /** The previous message's `messageIdHeader`, or null for the thread opener. */
  inReplyTo: string | null;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  dateISO: string;
  body: string;
  /** Per-message labels: the owner's own messages are SENT, not INBOX/UNREAD. */
  labels: string[];
}

export interface GmailWireThread {
  id: string;
  subject: string;
  labels: string[];
  messages: GmailWireMessage[];
}

export interface GmailWireSeed {
  world: SeedWorld;
  /** The instant every relative offset in the source seed was resolved against. */
  nowISO: string;
  /** Make the seeded state the one `reset` returns to. */
  promoteToSnapshot: boolean;
  /** `"Priya Raman <priya.raman@northwind.com>"` — whose mailbox this is. */
  ownerAddress: string;
  threads: GmailWireThread[];
}

export interface SeedRequest {
  twin: "gmail";
  seed: GmailSeedSpec | GmailWireSeed;
}

/**
 * The contract's response: `{ ok, counts }` and nothing else. `counts` is
 * free-form per twin and counts what was actually written, because it is what
 * the dashboard's clone step shows a user who is asking "did that work?".
 */
export interface SeedResult {
  ok: true;
  counts: { messages: number; threads: number; labels: number };
}
