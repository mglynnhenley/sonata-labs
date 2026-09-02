import type { EpisodeSpec, TwinName, WorldSeed } from "@sonata/core";
import { TWIN_NAMES, owner } from "@sonata/core";
import {
  canonicalize,
  narrateSurfaces,
  resetClient,
  type GeneratedWorld,
  type SlackSeed,
  type WorldDraft,
} from "@sonata/world";
import { mirrorWorld } from "../../../app/api/_lib/mirror";
import { getWorld } from "../../../app/api/_lib/records";
import { putDoc } from "../../../app/api/_lib/store";
import type { WorldCounts, WorldRecord } from "../../../app/api/_lib/types";
import { listWorlds as listWorldRows, markWorldSeeded } from "../db";
import { getApiKey } from "../settings";
import { TWIN_LABELS, twinStatus, twinUrl } from "../twins";
import { loadClone } from "./preflight";

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
    // The same arithmetic @sonata/world's own `previewWorld` does, in the same
    // words: the preview a user reads before seeding and the record written
    // after it are describing one backlog, and two different definitions of "a
    // CRM record" would make them disagree about it.
    records:
      clone.attio.companies.length + clone.attio.contacts.length + clone.attio.deals.length,
    documents: clone.googleDocs.documents.length,
    campaigns: clone.googleAds.campaigns.length,
    posts: clone.linkedin.posts.length,
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
  /** Narrowed to what is actually read, so a saved world can grow one without
   *  inventing a day for it. A whole `EpisodeSpec` still satisfies it. */
  spec: Pick<EpisodeSpec, "id" | "world">,
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
    // The narrative pass writes every surface in one reply, so a backlog grown
    // for an existing world fills the CRM, the documents, the ad account and the
    // page from the same story as the inbox.
    attio: seeds.attio,
    googleDocs: seeds.googleDocs,
    googleAds: seeds.googleAds,
    linkedin: seeds.linkedin,
  });
}

// ---------------------------------------------------------------------------
// Putting a company INTO the clones, on demand.
//
// This used to happen only at the top of a run, which meant a user could clone a
// business, open the fake Gmail and find the previous company still sitting in
// it. Seeding is now something you can ask for by name — and it goes through the
// same `loadClone` → `injectWorld` the run uses, so "seed it now" and "seed it at
// tick 0" cannot put two different companies in front of the agent.
// ---------------------------------------------------------------------------

/**
 * How each twin words its own inventory, in the order a person reads it.
 *
 * Keyed by the noun the TWIN sends back in its `counts`, not by anything this
 * app decides, because the receipt is meant to be the clone's own account of
 * what it now holds. A key with no entry here still prints — as the raw word,
 * which is why "1 documents" is what the four later surfaces read like until
 * they are listed. The headline noun of each twin sorts first.
 */
const LANDED_NOUNS: Record<string, { one: string; many: string; order: number }> = {
  threads: { one: "thread", many: "threads", order: 0 },
  messages: { one: "message", many: "messages", order: 1 },
  labels: { one: "label", many: "labels", order: 2 },
  channels: { one: "channel", many: "channels", order: 0 },
  users: { one: "person", many: "people", order: 3 },
  calendars: { one: "calendar", many: "calendars", order: 1 },
  events: { one: "event", many: "events", order: 0 },
  // attio
  companies: { one: "company", many: "companies", order: 0 },
  people: { one: "contact", many: "contacts", order: 1 },
  deals: { one: "deal", many: "deals", order: 2 },
  notes: { one: "note", many: "notes", order: 3 },
  tasks: { one: "task", many: "tasks", order: 4 },
  // google-docs
  documents: { one: "document", many: "documents", order: 0 },
  paragraphs: { one: "paragraph", many: "paragraphs", order: 1 },
  // google-ads
  campaigns: { one: "campaign", many: "campaigns", order: 0 },
  adGroups: { one: "ad group", many: "ad groups", order: 1 },
  budgets: { one: "budget", many: "budgets", order: 2 },
  statRows: { one: "day of stats", many: "days of stats", order: 3 },
  // linkedin
  posts: { one: "post", many: "posts", order: 0 },
  comments: { one: "comment", many: "comments", order: 1 },
  reactions: { one: "reaction", many: "reactions", order: 2 },
  organizations: { one: "page", many: "pages", order: 3 },
  members: { one: "member", many: "members", order: 4 },
};

export interface LandedItem {
  /** Already pluralised against `count`: "19 threads", "1 label". */
  label: string;
  count: number;
}

export interface TwinLanding {
  twin: TwinName;
  label: string;
  url: string;
  /** What the clone said it now holds, in its own words — not what we sent. */
  items: LandedItem[];
}

export interface SeedOutcome {
  worldId: string;
  worldName: string;
  seededAt: number;
  /** True when the company's history had to be written first — a model call. */
  wroteBacklog: boolean;
  landed: TwinLanding[];
}

export interface DownClone {
  twin: TwinName;
  label: string;
  url: string;
  /** The registry's own words: "not running", "connection refused". */
  detail: string;
}

/**
 * A clone that is not answering, named rather than swallowed.
 *
 * Seeding deliberately does not start twins for you the way a run does: this is
 * a destructive one-click action, and "Slack was off so I started it and then
 * replaced everything in it" is not a thing to do behind someone's back. The
 * caller is handed the list and offers the button.
 */
export class ClonesDownError extends Error {
  constructor(readonly down: DownClone[]) {
    super(
      `${down.map((d) => d.label).join(" and ")} ` +
        `${down.length === 1 ? "is" : "are"} not running, so the company cannot be loaded.`,
    );
    this.name = "ClonesDownError";
  }
}

/** Its own type so a route can answer 404 without matching on prose. */
export class UnknownCompanyError extends Error {
  constructor(worldId: string) {
    super(`No company with id "${worldId}".`);
    this.name = "UnknownCompanyError";
  }
}

export interface SeedCompanyOptions {
  say?: (msg: string) => void;
  /** Passed through when the backlog has to be written first. */
  model?: string;
}

function landingsFrom(counts: Record<string, number>, twins: readonly TwinName[]): TwinLanding[] {
  return twins.map((twin) => {
    const items = Object.entries(counts)
      .filter(([key]) => key.startsWith(`${twin}.`))
      .map(([key, count]) => ({ what: key.slice(twin.length + 1), count }))
      .sort((a, b) => (LANDED_NOUNS[a.what]?.order ?? 9) - (LANDED_NOUNS[b.what]?.order ?? 9))
      .map(({ what, count }) => {
        const noun = LANDED_NOUNS[what];
        const word = noun ? (count === 1 ? noun.one : noun.many) : what;
        return { label: `${count} ${word}`, count };
      });
    return { twin, label: TWIN_LABELS[twin], url: twinUrl(twin), items };
  });
}

/**
 * Let the world seeder see the key the user typed into Settings.
 *
 * @sonata/world keeps its own OpenRouter client and reads only the environment.
 * That is right for the CLI and wrong here: in a UI-only install the key is a
 * row in platform.db and there is no variable to find, so a user who had already
 * saved one was told to go and export it. Routing the call through the
 * dashboard's own client instead would work, but it sends the schema
 * non-strict and drops the reasoning effort the narrative pass asks for — so the
 * key goes to the seeder rather than the seeder's work coming here. `resetClient`
 * is the package's own seam, so a key replaced on Settings takes effect without
 * a restart.
 */
function useStoredKeyForNarration(): void {
  const key = getApiKey();
  if (!key) {
    throw new Error(
      "Writing a company's history is a model call, and no OpenRouter key is saved. " +
        "Add one in Settings, then seed again.",
    );
  }
  if (process.env.OPENROUTER_API_KEY === key) return;
  process.env.OPENROUTER_API_KEY = key;
  resetClient();
}

/**
 * Write the days behind this company and keep them.
 *
 * Saved before anything is injected, because the backlog costs a model call and
 * a minute: a clone that then refuses the seed must not also cost the writing
 * twice. The canonicalized world replaces the saved seed for the same reason
 * `createWorldFromBrief` does it — `canonicalize` re-derives channel membership
 * from the Slack backlog, so keeping the old seed would leave the record and the
 * twins disagreeing about who is in #ops.
 */
async function writeBacklog(
  record: WorldRecord,
  opts: SeedCompanyOptions,
): Promise<GeneratedWorld> {
  useStoredKeyForNarration();
  opts.say?.("writing the days behind this one, across all three surfaces");
  const clone = await growBacklog({ id: record.id, world: record.seed }, record.brief, {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.say ? { say: opts.say } : {}),
  });
  const next: WorldRecord = {
    ...record,
    seed: clone.world,
    counts: actualCounts(clone),
    clone,
  };
  putDoc("world", record.id, next);
  mirrorWorld(next);
  return clone;
}

/**
 * This business, in all three clones, now.
 *
 * Destructive by nature — `injectWorld` rebuilds each twin from the body rather
 * than adding to it — so whatever the clones held, including anything an agent
 * did during a run, is gone afterwards. The caller is expected to have said so.
 */
export async function seedCompany(
  worldId: string,
  opts: SeedCompanyOptions = {},
): Promise<SeedOutcome> {
  const record = getWorld(worldId);
  if (!record) throw new UnknownCompanyError(worldId);

  // Checked before the backlog is written: a minute of narration followed by
  // "Slack isn't running" is a minute nobody gets back.
  const twins = [...TWIN_NAMES];
  const health = await Promise.all(twins.map((twin) => twinStatus(twin, true)));
  const down = health.filter((h) => !h.ok);
  if (down.length > 0) {
    throw new ClonesDownError(
      down.map((h) => ({ twin: h.twin, label: h.label, url: h.url, detail: h.detail })),
    );
  }

  const existing = record.clone;
  const clone = existing ?? (await writeBacklog(record, opts));
  const counts = await loadClone(clone, twins, opts.say ?? (() => {}));

  const seededAt = Date.now();
  markWorldSeeded(worldId, seededAt);
  return {
    worldId,
    worldName: clone.world.business.name,
    seededAt,
    wroteBacklog: existing === undefined,
    landed: landingsFrom(counts, twins),
  };
}

// ---------------------------------------------------------------------------
// What the Companies page reads
// ---------------------------------------------------------------------------

/**
 * `seeded` — this is the company in the clones right now. `superseded` — it was,
 * until another one replaced it. `never` — it has only ever been a record here.
 *
 * There is one set of clones, so exactly one company can be `seeded`.
 */
export type SeedState = "seeded" | "superseded" | "never";

export interface CompanyCard {
  id: string;
  name: string;
  description: string;
  industry: string;
  /** The sentence the user typed to clone the business. */
  brief: string;
  createdAt: number;
  castSize: number;
  channelCount: number;
  /**
   * What has actually been written, or null when nothing has: a company with no
   * backlog is a cast list, and printing the numbers its preview promised would
   * be describing an inbox that does not exist yet.
   */
  counts: WorldCounts | null;
  seededAt: number | null;
  state: SeedState;
  /** The company that displaced it, when `superseded`. */
  supersededBy: string | null;
}

export function listCompanies(): CompanyCard[] {
  const rows = listWorldRows();
  // Only one company can be in the clones, and it is the one seeded last —
  // every seed rebuilds all three twins from scratch.
  const current = rows
    .filter((row) => row.seededAt !== null)
    .sort((a, b) => (b.seededAt ?? 0) - (a.seededAt ?? 0))[0];

  return rows.map((row) => {
    const record = getWorld(row.id);
    const state: SeedState =
      row.seededAt === null ? "never" : row.id === current?.id ? "seeded" : "superseded";
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      industry: row.industry,
      brief: row.prompt,
      createdAt: row.createdAt,
      castSize: row.castSize,
      channelCount: row.channelCount,
      counts: record?.clone ? record.counts : null,
      seededAt: row.seededAt,
      state,
      supersededBy: state === "superseded" ? (current?.name ?? null) : null,
    };
  });
}
