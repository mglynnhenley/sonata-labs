import { randomBytes } from "node:crypto";

// Gmail message/thread ids are 16 lowercase-hex characters. We generate the
// same shape for sandbox-created messages so agents can't tell them apart.
export function newHexId(): string {
  return randomBytes(8).toString("hex");
}

export const newMessageId = newHexId;
export const newThreadId = newHexId;

// Draft ids are distinct from message ids in Gmail. Shape doesn't matter to
// callers as long as it's opaque and stable; we prefix to make them visually
// distinguishable in logs.
export function newDraftId(): string {
  return "r-" + randomBytes(8).toString("hex");
}

// Attachment ids are long opaque base64url-ish strings in Gmail.
export function newAttachmentId(): string {
  return randomBytes(24).toString("base64url");
}

// User label ids are "Label_<n>". The caller supplies the next ordinal.
export function userLabelId(n: number): string {
  return `Label_${n}`;
}
