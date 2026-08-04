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
import { resolveLabelByName } from "../store/labels";
import { setMeta } from "../store/meta";
import { BadRequestError } from "./auth";
import { markWorkingSwapped } from "./live";
import { joinAddrs, resolveAtMs, writeEmail } from "./mail";
import type {
  GmailSeedSpec,
  GmailWireMessage,
  GmailWireSeed,
  SeedRequest,
  SeedResult,
} from "./types";

// Load a cloned company into the mailbox. Seeding is TOTAL and idempotent: the
// mailbox is built from scratch in a scratch file and then published, so the
// previous company's mail can never survive into the new one — an agent would
// read it and reason about it.
//
// Two bodies arrive here, and both are the caller's shape rather than ours:
//   * the world seeder's wire seed (`{world, nowISO, ownerAddress, threads}`),
//     which carries every id, address and absolute date already resolved, and
//   * the engine's cast-only spec (`{profileEmail, labels, messages}`), which
//     seeds the mailbox an episode's beats then play into.
// Anything else is a 400 — a silently empty mailbox is the failure this route
// exists to make impossible.

const SUFFIXES = ["", "-wal", "-shm"];

/** Built here, then published as snapshot.db or working.db — never both half-way. */
const BUILD_PATH = path.join(DATA_DIR, "seed-build.db");

interface SystemLabel {
  id: string;
  hidden?: boolean;
}

/**
 * Gmail's system labels, which exist in every real mailbox and which the API,
 * the UI and every seeded message reference by id. Created before anything else
 * so a seed spec never has to declare them.
 */
const SYSTEM_LABELS: SystemLabel[] = [
  { id: "INBOX" },
  { id: "SENT" },
  { id: "DRAFT", hidden: true },
  { id: "TRASH", hidden: true },
  { id: "SPAM", hidden: true },
  { id: "STARRED" },
  { id: "IMPORTANT" },
  { id: "UNREAD" },
  { id: "CATEGORY_PERSONAL" },
  { id: "CATEGORY_SOCIAL" },
  { id: "CATEGORY_PROMOTIONS" },
  { id: "CATEGORY_UPDATES" },
  { id: "CATEGORY_FORUMS" },
];

export type ParsedSeed =
  | { kind: "wire"; seed: GmailWireSeed }
  | { kind: "spec"; seed: GmailSeedSpec };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || !value) throw new BadRequestError(`${where} is required`);
  return value;
}

/** `"Priya Raman <priya@x.com>"` → `"priya@x.com"`; a bare address passes through. */
function addressOf(display: string): string {
  const angled = display.match(/<([^>]+)>/);
  return (angled?.[1] ?? display).trim();
}

function parseWireMessage(m: GmailWireMessage, where: string): void {
  requireString(m?.id, `${where}.id`);
  requireString(m.messageIdHeader, `${where}.messageIdHeader`);
  requireString(m.from, `${where}.from`);
  if (!Array.isArray(m.to) || !Array.isArray(m.cc)) {
    throw new BadRequestError(`${where}: to and cc must be arrays`);
  }
  if (typeof m.subject !== "string") throw new BadRequestError(`${where}.subject is required`);
  if (typeof m.body !== "string") throw new BadRequestError(`${where}.body is required`);
  if (!Array.isArray(m.labels)) throw new BadRequestError(`${where}.labels must be an array`);
  if (!Number.isFinite(Date.parse(m.dateISO))) {
    throw new BadRequestError(`${where}: dateISO '${String(m.dateISO)}' is not a date`);
  }
}

function parseWireSeed(seed: Record<string, unknown>): GmailWireSeed {
  const world = seed.world;
  if (!isRecord(world) || !Array.isArray(world.cast)) {
    throw new BadRequestError("seed.world.cast must be an array — the shared cast is the world");
  }
  requireString(seed.nowISO, "seed.nowISO");
  if (typeof seed.promoteToSnapshot !== "boolean") {
    throw new BadRequestError("seed.promoteToSnapshot must be a boolean");
  }
  const ownerAddress = requireString(seed.ownerAddress, "seed.ownerAddress");
  if (!Array.isArray(seed.threads)) throw new BadRequestError("seed.threads must be an array");

  const wire = seed as unknown as GmailWireSeed;

  // The one integrity check this twin can make against the cast: the mailbox it
  // is being asked to build must belong to the world's own mailbox owner. A seed
  // that fails it was resolved against a different world, and every criterion
  // written about "me" would silently be about somebody else.
  const me = wire.world.cast.find((p) => p.id === wire.world.mailboxOwner);
  if (me && addressOf(ownerAddress).toLowerCase() !== me.email.toLowerCase()) {
    throw new BadRequestError(
      `seed.ownerAddress '${ownerAddress}' is not the world's mailbox owner (${me.email})`,
    );
  }

  wire.threads.forEach((thread, ti) => {
    const where = `seed.threads[${ti}]`;
    requireString(thread?.id, `${where}.id`);
    if (typeof thread.subject !== "string") {
      throw new BadRequestError(`${where}.subject is required`);
    }
    if (!Array.isArray(thread.labels)) throw new BadRequestError(`${where}.labels must be an array`);
    if (!Array.isArray(thread.messages)) {
      throw new BadRequestError(`${where}.messages must be an array`);
    }
    thread.messages.forEach((m, mi) => parseWireMessage(m, `${where}.messages[${mi}]`));
  });
  return wire;
}

function parseSpecSeed(seed: Record<string, unknown>): GmailSeedSpec {
  requireString(seed.profileEmail, "seed.profileEmail");
  if (!Array.isArray(seed.messages)) throw new BadRequestError("seed.messages must be an array");
  return seed as unknown as GmailSeedSpec;
}

export function parseSeedRequest(body: unknown): ParsedSeed {
  if (!isRecord(body)) throw new BadRequestError("body must be a JSON object");
  const b = body as Partial<SeedRequest>;
  if (b.twin !== "gmail") {
    throw new BadRequestError(`this twin seeds 'gmail', not '${String(b.twin)}'`);
  }
  const seed = b.seed;
  if (!isRecord(seed)) throw new BadRequestError("seed is required");
  // `world` is what tells the two bodies apart: only a wire seed carries the
  // shared cast, and only a wire seed hands this twin ids to honour verbatim.
  if ("world" in seed) return { kind: "wire", seed: parseWireSeed(seed) };
  return { kind: "spec", seed: parseSpecSeed(seed) };
}

function rmFiles(base: string): void {
  for (const s of SUFFIXES) rmSync(base + s, { force: true });
}

function writeLabels(db: Database.Database, extra: GmailSeedSpec["labels"]): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO labels
       (id, name, type, message_list_visibility, label_list_visibility, color_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const l of SYSTEM_LABELS) {
    insert.run(l.id, l.id, "system", l.hidden ? "hide" : "show", "labelShow", null);
  }
  for (const l of extra ?? []) {
    insert.run(
      l.id,
      l.name,
      l.type ?? "user",
      "show",
      "labelShow",
      l.color ? JSON.stringify(l.color) : null,
    );
  }
}

/**
 * Resolve a label string from a message to a label id, minting a user label when
 * it names neither an existing id nor an existing name. A spec that says
 * `labels: ["Escalations"]` without declaring the label should still produce a
 * mailbox where "Escalations" is a real, listable label.
 */
function labelIdFor(db: Database.Database, token: string): string {
  const byId = db.prepare("SELECT id FROM labels WHERE id = ?").get(token) as
    | { id: string }
    | undefined;
  if (byId) return byId.id;
  const byName = resolveLabelByName(db, token);
  if (byName) return byName.id;
  db.prepare(
    `INSERT INTO labels (id, name, type, message_list_visibility, label_list_visibility, color_json)
     VALUES (?, ?, 'user', 'show', 'labelShow', NULL)`,
  ).run(token, token);
  return token;
}

function writeSpecMessages(db: Database.Database, spec: GmailSeedSpec): void {
  const refs: Record<string, { id: string; threadId: string }> = {};
  const rfc822ByRef = new Map<string, string>();

  // Oldest first, so a reply can only ever thread onto a message that already
  // exists — and so history ids increase with time, as they do in real Gmail.
  const ordered = spec.messages
    .map((m, i) => ({ m, i, atMs: resolveAtMs(m, `seed.messages[${i}]`) }))
    .sort((a, b) => a.atMs - b.atMs || a.i - b.i);

  for (const { m, i, atMs } of ordered) {
    if (!m.from) throw new BadRequestError(`seed.messages[${i}]: from is required`);
    if (typeof m.subject !== "string") {
      throw new BadRequestError(`seed.messages[${i}]: subject is required`);
    }
    if (typeof m.body !== "string") {
      throw new BadRequestError(`seed.messages[${i}]: body is required`);
    }

    const parent = m.inReplyTo ? refs[m.inReplyTo] : undefined;
    if (m.inReplyTo && !parent) {
      throw new BadRequestError(
        `seed.messages[${i}]: inReplyTo '${m.inReplyTo}' names no earlier message`,
      );
    }

    const labelIds = (m.labels?.length ? m.labels : ["INBOX"]).map((t) => labelIdFor(db, t));
    const cc = joinAddrs(m.cc);
    const written = writeEmail(db, {
      from: m.from,
      to: joinAddrs(m.to) || spec.profileEmail,
      cc: cc || undefined,
      subject: m.subject,
      body: m.body,
      atMs,
      labelIds,
      threadId: parent?.threadId,
      inReplyTo: m.inReplyTo ? rfc822ByRef.get(m.inReplyTo) : undefined,
    });

    if (m.ref) {
      refs[m.ref] = { id: written.id, threadId: written.threadId };
      rfc822ByRef.set(m.ref, written.rfc822MessageId);
    }
  }
}

function writeWireThreads(db: Database.Database, wire: GmailWireSeed): void {
  // Thread-level labels are created even when no message carries them, so a
  // clone's own vocabulary ("Escalations") is listable from the first request.
  for (const thread of wire.threads) for (const token of thread.labels) labelIdFor(db, token);

  // Flattened and sorted by date so history ids increase with simulated time
  // across the whole mailbox, not just within a thread. Threading needs no
  // ordering here at all: the wire seed already carries every id.
  const flat = wire.threads
    .flatMap((thread) => thread.messages.map((m) => ({ thread, m, atMs: Date.parse(m.dateISO) })))
    .sort((a, b) => a.atMs - b.atMs);

  for (const { thread, m, atMs } of flat) {
    const labelIds = (m.labels.length ? m.labels : ["INBOX"]).map((t) => labelIdFor(db, t));
    writeEmail(db, {
      id: m.id,
      rfc822MessageId: m.messageIdHeader,
      from: m.from,
      to: joinAddrs(m.to) || addressOf(wire.ownerAddress),
      cc: joinAddrs(m.cc) || undefined,
      subject: m.subject,
      body: m.body,
      atMs,
      labelIds,
      threadId: thread.id,
      inReplyTo: m.inReplyTo ?? undefined,
    });
  }
}

function countsOf(db: Database.Database): SeedResult["counts"] {
  return {
    messages: (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n,
    threads: (
      db.prepare("SELECT COUNT(DISTINCT thread_id) AS n FROM messages").get() as { n: number }
    ).n,
    labels: (db.prepare("SELECT COUNT(*) AS n FROM labels").get() as { n: number }).n,
  };
}

/**
 * Build a whole mailbox in a scratch file, then publish it.
 *
 * `promoteToSnapshot` decides what publishing means: true makes the seeded world
 * the state every later reset in the run returns to — that is what makes a
 * cloned business survive a run — while false swaps only the working mailbox and
 * leaves snapshot.db exactly as it was.
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
    // Checkpoint so the built mailbox is one self-contained file to publish.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  } catch (err) {
    db.close();
    // A half-written mailbox is worse than none: publishing it would start the
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

export function seedFromSpec(spec: GmailSeedSpec): SeedResult {
  return loadSeeded(true, (db) => {
    setMeta(db, "profile_email", spec.profileEmail);
    writeLabels(db, spec.labels);
    writeSpecMessages(db, spec);
  });
}

export function seedFromWire(wire: GmailWireSeed): SeedResult {
  return loadSeeded(wire.promoteToSnapshot, (db) => {
    // Gmail's "an account for every cast member" is one mailbox: the twin has no
    // user table, and everyone else exists as an address on a message.
    setMeta(db, "profile_email", addressOf(wire.ownerAddress));
    writeLabels(db, []);
    writeWireThreads(db, wire);
  });
}

export function seed(parsed: ParsedSeed): SeedResult {
  return parsed.kind === "wire" ? seedFromWire(parsed.seed) : seedFromSpec(parsed.seed);
}
