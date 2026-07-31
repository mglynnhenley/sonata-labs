import { randomBytes } from "node:crypto";

// Slack ids are an uppercase type prefix followed by 8–10 uppercase
// alphanumerics (e.g. U04V3AB12CD). We generate the same shape for
// sandbox-created resources so agents can't tell them apart.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomBody(len = 10): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function newId(prefix: string): string {
  return prefix + randomBody();
}

export const newUserId = () => newId("U");
export const newBotId = () => newId("B");
export const newTeamId = () => newId("T");
export const newChannelId = () => newId("C");
export const newImId = () => newId("D");
export const newGroupId = () => newId("G"); // legacy private channels / mpims
export const newFileId = () => newId("F");

/** Session/opaque ids for the audit log (not a Slack-visible shape). */
export function newHexId(): string {
  return randomBytes(8).toString("hex");
}
