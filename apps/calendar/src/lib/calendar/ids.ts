import { randomBytes } from "node:crypto";

// Google Calendar event ids are base32hex (characters a-v and 0-9), 5–1024
// chars. We generate the same alphabet so agents can't tell sandbox-created
// events from seeded ones, and so ids survive being echoed back verbatim.
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

export function newEventId(): string {
  const bytes = randomBytes(26);
  let out = "";
  for (const b of bytes) out += BASE32HEX[b & 31];
  return out;
}

/** 16 lowercase-hex chars — used for audit session ids. */
export function newHexId(): string {
  return randomBytes(8).toString("hex");
}

/** Google's iCalUID for an event it created. */
export function icalUidFor(eventId: string): string {
  return `${eventId}@google.com`;
}

/**
 * Instance id for one occurrence of a recurring event: the master id, an
 * underscore, and the occurrence's original start in UTC basic format
 * (`20260804T160000Z`, or `20260804` for all-day). Exactly Google's format —
 * agents pass these back to events.get/patch.
 */
export function instanceId(masterId: string, startMs: number, allDay: boolean): string {
  const d = new Date(startMs);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const date = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  if (allDay) return `${masterId}_${date}`;
  const time = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${masterId}_${date}T${time}Z`;
}

/** Split an instance id back into its master id (or null if it isn't one). */
export function masterIdOf(id: string): string | null {
  const m = id.match(/^(.+)_(\d{8}(?:T\d{6}Z)?)$/);
  return m ? m[1] : null;
}
