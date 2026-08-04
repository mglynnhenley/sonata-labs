import type { Database } from "better-sqlite3";
import { getConversation, getConversationByName } from "../store/conversations";
import { getUser, getUserByName } from "../store/users";
import type { ConversationRow } from "../slack/types";
import { BadRequestError } from "./auth";
import type { SimTime } from "./types";

// Beats name people and places the way a person would — "#ops", "@priya" — and
// the twin resolves them to ids. Doing it here rather than in the engine keeps
// the episode spec readable and lets a beat survive a re-seed that mints new ids.

/** Resolve simulated time, or fail loudly — never silently fall back to now. */
export function resolveAtMs(t: SimTime, what: string): number {
  if (typeof t.atMs === "number" && Number.isFinite(t.atMs)) return t.atMs;
  if (t.atISO) {
    const parsed = Date.parse(t.atISO);
    if (Number.isFinite(parsed)) return parsed;
    throw new BadRequestError(`${what}: atISO '${t.atISO}' is not a date`);
  }
  throw new BadRequestError(`${what}: atMs or atISO is required`);
}

export function resolveChannel(db: Database, token: string | undefined): ConversationRow {
  if (!token) throw new BadRequestError("channel is required");
  const byId = getConversation(db, token);
  if (byId) return byId;
  const byName = getConversationByName(db, token.replace(/^#/, ""));
  if (byName) return byName;
  throw new BadRequestError(`channel '${token}' not found`);
}

/**
 * Users are never minted on the fly: an author who is not in the cast would show
 * up in the UI as a bare id and read to the agent as a stranger, which is a
 * scenario bug worth surfacing rather than papering over.
 */
export function resolveUserId(db: Database, token: string | undefined): string {
  if (!token) throw new BadRequestError("user is required");
  const byId = getUser(db, token);
  if (byId) return byId.id;
  const byName = getUserByName(db, token.replace(/^@/, ""));
  if (byName) return byName.id;
  throw new BadRequestError(`user '${token}' not found`);
}

/** Emoji names arrive bare ("eyes"); tolerate wrapping colons, like the API does. */
export function normalizeEmoji(raw: string | undefined): string {
  const name = (raw ?? "").replace(/^:|:$/g, "").trim();
  if (!name) throw new BadRequestError("emoji is required");
  return name;
}
