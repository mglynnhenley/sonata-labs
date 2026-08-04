import type { Database } from "better-sqlite3";
import {
  getMessageRow,
  getLabelIds,
  addLabels,
  removeLabels,
  deleteMessage,
  messageExists,
  bumpMessageHistory,
  messageIdsInThread,
} from "../store/messages";
import { labelExists } from "../store/labels";
import { nextHistoryId } from "../store/meta";
import { shapeMessage, canReturnRaw } from "./shape";
import { GmailError, notFoundError } from "./errors";
import type { GmailMessage } from "./types";

// Mutation primitives. Each assumes it runs INSIDE a transaction (the route's
// runMutation wrapper) and bumps historyId itself. Audit rows are written by
// the wrapper so they commit atomically with the change.

function assertLabelsExist(db: Database, labelIds: string[]): void {
  for (const id of labelIds) {
    if (!labelExists(db, id)) {
      throw new GmailError(400, `Invalid label: ${id}`, "invalidArgument");
    }
  }
}

function shaped(db: Database, id: string): GmailMessage {
  const row = getMessageRow(db, id)!;
  return shapeMessage(row, getLabelIds(db, id), "full");
}

export function modifyMessage(
  db: Database,
  id: string,
  add: string[],
  remove: string[],
): GmailMessage {
  if (!messageExists(db, id)) throw notFoundError();
  assertLabelsExist(db, [...add, ...remove]);
  // Remove first, then add (add wins on overlap — matches user intent).
  removeLabels(db, id, remove);
  addLabels(db, id, add);
  bumpMessageHistory(db, [id]);
  return shaped(db, id);
}

export function trashMessage(db: Database, id: string): GmailMessage {
  if (!messageExists(db, id)) throw notFoundError();
  addLabels(db, id, ["TRASH"]);
  removeLabels(db, id, ["INBOX"]); // trash removes INBOX
  bumpMessageHistory(db, [id]);
  return shaped(db, id);
}

export function untrashMessage(db: Database, id: string): GmailMessage {
  if (!messageExists(db, id)) throw notFoundError();
  removeLabels(db, id, ["TRASH"]); // untrash does NOT restore INBOX
  bumpMessageHistory(db, [id]);
  return shaped(db, id);
}

export function deleteMessagePermanent(db: Database, id: string): void {
  if (!messageExists(db, id)) throw notFoundError();
  deleteMessage(db, id);
  nextHistoryId(db);
}

export function batchModifyMessages(
  db: Database,
  ids: string[],
  add: string[],
  remove: string[],
): void {
  assertLabelsExist(db, [...add, ...remove]);
  const present = ids.filter((id) => messageExists(db, id));
  for (const id of present) {
    removeLabels(db, id, remove);
    addLabels(db, id, add);
  }
  bumpMessageHistory(db, present);
}

export function batchDeleteMessages(db: Database, ids: string[]): void {
  for (const id of ids) if (messageExists(db, id)) deleteMessage(db, id);
  nextHistoryId(db);
}

// --- thread variants (apply to every message in the thread) ------------------

function threadMessageIds(db: Database, threadId: string): string[] {
  const ids = messageIdsInThread(db, threadId);
  if (ids.length === 0) throw notFoundError();
  return ids;
}

export function modifyThread(db: Database, threadId: string, add: string[], remove: string[]): void {
  assertLabelsExist(db, [...add, ...remove]);
  const ids = threadMessageIds(db, threadId);
  for (const id of ids) {
    removeLabels(db, id, remove);
    addLabels(db, id, add);
  }
  bumpMessageHistory(db, ids);
}

export function trashThread(db: Database, threadId: string): void {
  const ids = threadMessageIds(db, threadId);
  for (const id of ids) {
    addLabels(db, id, ["TRASH"]);
    removeLabels(db, id, ["INBOX"]);
  }
  bumpMessageHistory(db, ids);
}

export function untrashThread(db: Database, threadId: string): void {
  const ids = threadMessageIds(db, threadId);
  for (const id of ids) removeLabels(db, id, ["TRASH"]);
  bumpMessageHistory(db, ids);
}

export function deleteThreadPermanent(db: Database, threadId: string): void {
  const ids = threadMessageIds(db, threadId);
  for (const id of ids) deleteMessage(db, id);
  nextHistoryId(db);
}

export { canReturnRaw };
