import Database from "better-sqlite3";
import { renameSync, rmSync } from "node:fs";
import path from "node:path";
import {
  closeWorkingDb,
  DATA_DIR,
  ensureDataDir,
  getDb,
  readSchema,
  SNAPSHOT_PATH,
  WORKING_PATH,
} from "../db";
import { startNewSession } from "../audit";
import { resetWorking } from "../reset";
import { insertUser } from "../store/users";
import { addMember, insertConversation } from "../store/conversations";
import { insertMessage } from "../store/messages";
import { addReaction } from "../store/reactions";
import { setLastRead } from "../store/read-state";
import { setSelf } from "../store/meta";
import { newChannelId, newGroupId } from "../slack/ids";
import { compareTs, mintTs, msToTs } from "../slack/ts";
import { BadRequestError } from "./auth";
import { markWorkingSwapped } from "./live";
import { channelRawJson, messageRawJson, userRawJson } from "./raw";
import type {
  SeedRequest,
  SeedResult,
  SlackSeedSpec,
  SlackSeedUser,
  SlackWireSeed,
} from "./types";

// Load a cloned company into the workspace. Seeding is TOTAL and idempotent: the
// workspace is built from scratch in a scratch file and then published, so the
// previous company's channels can never survive into the new one — an agent
// would read them and reason about them.
//
// Two bodies arrive here, and both are the caller's shape rather than ours:
//   * the world seeder's wire seed (`{world, nowISO, ownerUserId, channels}`),
//     which carries every user id, channel id and `ts` already resolved, and
//   * the engine's cast-only spec (`{self, users, channels, messages}`), which
//     seeds the workspace an episode's beats then play into.
// Anything else is a 400 — a silently empty sidebar is the failure this route
// exists to make impossible.

const SUFFIXES = ["", "-wal", "-shm"];
const DAY_MS = 86_400_000;

/** Built here, then published as snapshot.db or working.db — never both half-way. */
const BUILD_PATH = path.join(DATA_DIR, "seed-build.db");

const DEFAULT_TEAM_ID = "T0SONATA001";

export type ParsedSeed =
  | { kind: "wire"; seed: SlackWireSeed }
  | { kind: "spec"; seed: SlackSeedSpec };

function rmFiles(base: string): void {
  for (const s of SUFFIXES) rmSync(base + s, { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || !value) throw new BadRequestError(`${where} is required`);
  return value;
}

function parseWireSeed(seed: Record<string, unknown>): SlackWireSeed {
  const world = seed.world;
  if (!isRecord(world) || !Array.isArray(world.cast) || world.cast.length === 0) {
    throw new BadRequestError(
      "seed.world.cast must be a non-empty array — the shared cast is the world",
    );
  }
  requireString(seed.nowISO, "seed.nowISO");
  if (typeof seed.promoteToSnapshot !== "boolean") {
    throw new BadRequestError("seed.promoteToSnapshot must be a boolean");
  }
  const ownerUserId = requireString(seed.ownerUserId, "seed.ownerUserId");
  if (!Array.isArray(seed.channels)) throw new BadRequestError("seed.channels must be an array");

  const wire = seed as unknown as SlackWireSeed;

  // The one integrity check this twin can make against the cast: the session it
  // is being asked to build has to belong to somebody in the world. Minting the
  // owner instead would give the agent a workspace nobody else can see.
  if (!wire.world.cast.some((p) => p.slackUserId === ownerUserId)) {
    throw new BadRequestError(`seed.ownerUserId '${ownerUserId}' is not in seed.world.cast`);
  }

  const knownUsers = new Set(wire.world.cast.map((p) => p.slackUserId));
  wire.channels.forEach((channel, ci) => {
    const where = `seed.channels[${ci}]`;
    requireString(channel?.id, `${where}.id`);
    requireString(channel.name, `${where}.name`);
    if (!Array.isArray(channel.memberIds)) {
      throw new BadRequestError(`${where}.memberIds must be an array`);
    }
    for (const id of channel.memberIds) {
      if (!knownUsers.has(id)) {
        throw new BadRequestError(`${where}: member '${id}' is not in seed.world.cast`);
      }
    }
    if (!Array.isArray(channel.messages)) {
      throw new BadRequestError(`${where}.messages must be an array`);
    }
    let previous: string | null = null;
    channel.messages.forEach((m, mi) => {
      const at = `${where}.messages[${mi}]`;
      requireString(m?.ts, `${at}.ts`);
      if (typeof m.text !== "string") throw new BadRequestError(`${at}.text is required`);
      if (!knownUsers.has(m.userId)) {
        throw new BadRequestError(`${at}: user '${String(m.userId)}' is not in seed.world.cast`);
      }
      // `ts` is the message id AND the sort key, so a channel whose ts values do
      // not strictly increase is a scenario bug worth a 400: seeding it would
      // either collide on the primary key or silently reorder the story.
      if (previous !== null && compareTs(m.ts, previous) <= 0) {
        throw new BadRequestError(`${at}: ts '${m.ts}' does not advance past '${previous}'`);
      }
      previous = m.ts;
    });
  });
  return wire;
}

function parseSpecSeed(seed: Record<string, unknown>): SlackSeedSpec {
  if (!Array.isArray(seed.users) || seed.users.length === 0) {
    throw new BadRequestError("seed.users must be a non-empty array");
  }
  if (!Array.isArray(seed.channels)) throw new BadRequestError("seed.channels must be an array");
  if (!Array.isArray(seed.messages)) throw new BadRequestError("seed.messages must be an array");
  requireString(seed.self, "seed.self");
  return seed as unknown as SlackSeedSpec;
}

export function parseSeedRequest(body: unknown): ParsedSeed {
  if (!isRecord(body)) throw new BadRequestError("body must be a JSON object");
  const b = body as Partial<SeedRequest>;
  if (b.twin !== "slack") {
    throw new BadRequestError(`this twin seeds 'slack', not '${String(b.twin)}'`);
  }
  const seed = b.seed;
  if (!isRecord(seed)) throw new BadRequestError("seed is required");
  // `world` is what tells the two bodies apart: only a wire seed carries the
  // shared cast, and only a wire seed hands this twin ids to honour verbatim.
  if ("world" in seed) return { kind: "wire", seed: parseWireSeed(seed) };
  return { kind: "spec", seed: parseSpecSeed(seed) };
}

/** A handle Slack would accept: lowercase, no spaces, unique in the workspace. */
function handleFor(u: SlackSeedUser, taken: Set<string>): string {
  const base =
    (u.name ?? u.realName.split(/\s+/)[0] ?? u.id).toLowerCase().replace(/[^a-z0-9._-]/g, "") ||
    u.id.toLowerCase();
  let handle = base;
  for (let n = 2; taken.has(handle); n++) handle = `${base}${n}`;
  taken.add(handle);
  return handle;
}

interface Cast {
  /** user id or handle → user id. */
  byToken: Map<string, string>;
  handles: Map<string, string>;
}

function writeUsers(db: Database.Database, spec: SlackSeedSpec, teamId: string, atMs: number): Cast {
  const taken = new Set<string>();
  const cast: Cast = { byToken: new Map(), handles: new Map() };
  const updated = Math.floor((atMs - 30 * DAY_MS) / 1000);

  for (const u of spec.users) {
    if (!u.id) throw new BadRequestError("seed.users[]: id is required");
    if (!u.realName) throw new BadRequestError(`seed.users[${u.id}]: realName is required`);
    const handle = handleFor(u, taken);
    const raw = userRawJson(u, handle, teamId, updated);
    insertUser(db, {
      id: u.id,
      teamId,
      name: handle,
      realName: u.realName,
      displayName: handle,
      tz: u.tz ?? "Europe/London",
      isBot: !!u.isBot,
      isAdmin: !!u.isAdmin,
      isOwner: !!u.isOwner,
      updated,
      profileJson: JSON.stringify((JSON.parse(raw) as { profile: unknown }).profile),
      rawJson: raw,
    });
    cast.byToken.set(u.id, u.id);
    cast.byToken.set(handle, u.id);
    cast.handles.set(u.id, handle);
  }
  return cast;
}

function requireUser(cast: Cast, token: string, where: string): string {
  const id = cast.byToken.get(token) ?? cast.byToken.get(token.replace(/^@/, ""));
  if (!id) throw new BadRequestError(`${where}: user '${token}' is not in seed.users`);
  return id;
}

function writeChannels(
  db: Database.Database,
  spec: SlackSeedSpec,
  cast: Cast,
  teamId: string,
  selfId: string,
  atMs: number,
): Record<string, string> {
  const ids: Record<string, string> = {};

  for (const c of spec.channels) {
    if (!c.name) throw new BadRequestError("seed.channels[]: name is required");
    const isPrivate = !!c.isPrivate;
    const id = c.id ?? (isPrivate ? newGroupId() : newChannelId());
    // A year of history behind the clone: channels that look minted this morning
    // read as fake, and "created 3 minutes ago" is a tell an agent can see.
    const created = Math.floor((c.createdAtMs ?? atMs - 365 * DAY_MS) / 1000);
    const members = (c.members ?? []).map((m) => requireUser(cast, m, `channel #${c.name}`));
    const creator = members[0] ?? selfId;

    insertConversation(db, {
      id,
      name: c.name,
      isChannel: !isPrivate,
      isGroup: isPrivate,
      isPrivate,
      isGeneral: c.name === "general",
      creator,
      created,
      topicJson: c.topic
        ? JSON.stringify({ value: c.topic, creator, last_set: created })
        : null,
      purposeJson: c.purpose
        ? JSON.stringify({ value: c.purpose, creator, last_set: created })
        : null,
      rawJson: channelRawJson({
        id,
        name: c.name,
        isPrivate,
        isGeneral: c.name === "general",
        creator,
        created,
        teamId,
      }),
    });
    for (const m of members) addMember(db, id, m);
    ids[c.name] = id;
  }
  return ids;
}

function channelIdFor(
  spec: SlackSeedSpec,
  ids: Record<string, string>,
  token: string,
  where: string,
): string {
  const byName = ids[token.replace(/^#/, "")];
  if (byName) return byName;
  const known = spec.channels.some((c) => c.id === token);
  if (known) return token;
  throw new BadRequestError(`${where}: channel '${token}' is not in seed.channels`);
}

function writeSpecMessages(
  db: Database.Database,
  spec: SlackSeedSpec,
  cast: Cast,
  channelIds: Record<string, string>,
  teamId: string,
): void {
  const refs: Record<string, { ts: string; channelId: string }> = {};

  // Oldest first, so a reply can only ever thread onto a message that already
  // exists, and so minted ts values increase with simulated time.
  const ordered = spec.messages
    .map((m, i) => ({ m, i, atMs: resolveMessageAt(m, i) }))
    .sort((a, b) => a.atMs - b.atMs || a.i - b.i);

  for (const { m, i, atMs } of ordered) {
    const where = `seed.messages[${i}]`;
    if (typeof m.text !== "string" || !m.text) {
      throw new BadRequestError(`${where}: text is required`);
    }
    const channelId = channelIdFor(spec, channelIds, m.channel, where);
    const user = requireUser(cast, m.user, where);

    let threadTs: string | null = null;
    if (m.replyTo) {
      const parent = refs[m.replyTo];
      if (!parent) {
        throw new BadRequestError(`${where}: replyTo '${m.replyTo}' names no earlier message`);
      }
      if (parent.channelId !== channelId) {
        throw new BadRequestError(`${where}: replyTo '${m.replyTo}' is in another channel`);
      }
      threadTs = parent.ts;
    }

    const ts = mintTs(db, channelId, atMs);
    insertMessage(db, {
      channelId,
      ts,
      threadTs,
      user,
      text: m.text,
      rawJson: messageRawJson({ user, text: m.text, ts, teamId }),
      isSandboxCreated: false,
    });

    for (const r of m.reactions ?? []) {
      for (const u of r.users) {
        addReaction(db, channelId, ts, r.emoji.replace(/^:|:$/g, ""), requireUser(cast, u, where));
      }
    }

    if (m.ref) refs[m.ref] = { ts, channelId };
  }
}

function resolveMessageAt(m: { atMs?: number; atISO?: string }, i: number): number {
  if (typeof m.atMs === "number" && Number.isFinite(m.atMs)) return m.atMs;
  if (m.atISO) {
    const parsed = Date.parse(m.atISO);
    if (Number.isFinite(parsed)) return parsed;
    throw new BadRequestError(`seed.messages[${i}]: atISO '${m.atISO}' is not a date`);
  }
  throw new BadRequestError(`seed.messages[${i}]: atMs or atISO is required`);
}

/**
 * Park the owner's read cursor. Everything up to `unreadFromMs` is read, so
 * during the run an unread badge means "arrived today" and nothing else.
 */
function writeReadState(
  db: Database.Database,
  channelIds: Record<string, string>,
  selfId: string,
  unreadFromMs: number | undefined,
): void {
  const cutoff = unreadFromMs === undefined ? null : msToTs(unreadFromMs);
  for (const id of Object.values(channelIds)) {
    const row = db
      .prepare(
        cutoff === null
          ? "SELECT MAX(ts) AS ts FROM messages WHERE channel_id = ?"
          : "SELECT MAX(ts) AS ts FROM messages WHERE channel_id = ? AND ts < ?",
      )
      .get(...(cutoff === null ? [id] : [id, cutoff])) as { ts: string | null };
    if (row.ts) setLastRead(db, id, selfId, row.ts);
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sandbox";
}

/**
 * The wire seed in the shape the shared writers already take. Users come from
 * the world's own cast — this twin never invents one — and channels keep the
 * ids, membership and privacy the seeder resolved. Messages are excluded on
 * purpose: they carry their own `ts` and are written verbatim, not minted.
 */
function specFromWire(wire: SlackWireSeed): SlackSeedSpec {
  return {
    team: { id: DEFAULT_TEAM_ID, name: wire.world.business.name, domain: slug(wire.world.business.name) },
    self: wire.ownerUserId,
    users: wire.world.cast.map((p) => ({
      id: p.slackUserId,
      realName: p.name,
      email: p.email,
      title: p.role,
    })),
    channels: wire.channels.map((c) => ({
      id: c.id,
      name: c.name,
      topic: c.topic,
      purpose: c.purpose,
      isPrivate: c.isPrivate,
      members: c.memberIds,
    })),
    messages: [],
  };
}

function writeWireMessages(db: Database.Database, wire: SlackWireSeed, teamId: string): void {
  for (const channel of wire.channels) {
    // In wire order, which the parser has already checked is strictly
    // increasing: a reply's parent is therefore always in place first, so
    // insertMessage can recompute the thread's stats as it goes.
    for (const m of channel.messages) {
      insertMessage(db, {
        channelId: channel.id,
        ts: m.ts,
        threadTs: m.threadTs,
        user: m.userId,
        text: m.text,
        rawJson: messageRawJson({ user: m.userId, text: m.text, ts: m.ts, teamId }),
        isSandboxCreated: false,
      });
    }
  }
}

function countsOf(db: Database.Database): SeedResult["counts"] {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { users: count("users"), channels: count("conversations"), messages: count("messages") };
}

/**
 * Build a whole workspace in a scratch file, then publish it.
 *
 * `promoteToSnapshot` decides what publishing means: true makes the seeded world
 * the state every later reset in the run returns to — that is what makes a
 * cloned business survive a run — while false swaps only the working workspace
 * and leaves snapshot.db exactly as it was.
 */
function loadSeeded(promoteToSnapshot: boolean, build: (db: Database.Database) => void): SeedResult {
  ensureDataDir();
  rmFiles(BUILD_PATH);

  const db = new Database(BUILD_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(readSchema());

  let counts: SeedResult["counts"];
  try {
    db.transaction(() => build(db))();
    counts = countsOf(db);
    // Checkpoint so the built workspace is one self-contained file to publish.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  } catch (err) {
    db.close();
    // A half-written workspace is worse than none: publishing it would start the
    // run inside a truncated company.
    rmFiles(BUILD_PATH);
    throw err;
  }

  const note = `seeded ${counts.messages} messages`;
  if (promoteToSnapshot) {
    rmFiles(SNAPSHOT_PATH);
    renameSync(BUILD_PATH, SNAPSHOT_PATH);
    resetWorking(note);
  } else {
    // In-process, like reset: the server owns the working handle, so only it can
    // close → swap files → reopen.
    closeWorkingDb();
    rmFiles(WORKING_PATH);
    renameSync(BUILD_PATH, WORKING_PATH);
    startNewSession(getDb(), note);
  }
  // Both branches replaced working.db; the freshness check must not read that
  // as somebody else swapping the file out from under us.
  markWorkingSwapped();
  return { ok: true, counts };
}

/** Cast, channels and self — everything but the messages, which differ per body. */
function writeWorkspace(
  db: Database.Database,
  spec: SlackSeedSpec,
  teamId: string,
  atMs: number,
): { cast: Cast; selfId: string; channelIds: Record<string, string> } {
  const cast = writeUsers(db, spec, teamId, atMs);
  const selfId = requireUser(cast, spec.self, "seed.self");
  setSelf(db, {
    teamId,
    teamName: spec.team?.name ?? "Sandbox",
    teamDomain: spec.team?.domain ?? "sandbox",
    userId: selfId,
    userName: cast.handles.get(selfId) ?? selfId,
  });
  const channelIds = writeChannels(db, spec, cast, teamId, selfId, atMs);
  return { cast, selfId, channelIds };
}

export function seedFromSpec(spec: SlackSeedSpec): SeedResult {
  const teamId = spec.team?.id ?? DEFAULT_TEAM_ID;
  // The clock the workspace's own history hangs off: the first thing that
  // happens in the story, so a seeded world always predates the run.
  const firstAtMs = spec.messages.length
    ? Math.min(...spec.messages.map((m, i) => resolveMessageAt(m, i)))
    : Date.now();

  return loadSeeded(true, (db) => {
    const { cast, selfId, channelIds } = writeWorkspace(db, spec, teamId, firstAtMs);
    writeSpecMessages(db, spec, cast, channelIds, teamId);
    writeReadState(db, channelIds, selfId, spec.unreadFromMs);
  });
}

export function seedFromWire(wire: SlackWireSeed): SeedResult {
  const spec = specFromWire(wire);
  const teamId = spec.team?.id ?? DEFAULT_TEAM_ID;
  const nowMs = Date.parse(wire.nowISO);

  return loadSeeded(wire.promoteToSnapshot, (db) => {
    const { selfId, channelIds } = writeWorkspace(db, spec, teamId, nowMs);
    writeWireMessages(db, wire, teamId);
    // A wire seed is settled history: all of it is read, so during the run an
    // unread badge means "arrived today" and nothing else.
    writeReadState(db, channelIds, selfId, undefined);
  });
}

export function seed(parsed: ParsedSeed): SeedResult {
  return parsed.kind === "wire" ? seedFromWire(parsed.seed) : seedFromSpec(parsed.seed);
}
