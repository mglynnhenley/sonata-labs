import type { Database } from "better-sqlite3";
import {
  prepareSend,
  persistPrepared,
  resolveThreadId,
  commitSend,
  type PreparedSend,
} from "./send";
import { newMessageId, newDraftId } from "./gmail/ids";
import {
  getMessageRow,
  getLabelIds,
  deleteMessage,
  messageExists,
} from "./store/messages";
import { bumpMessageHistory } from "./store/messages";
import {
  getDraftRow,
  insertDraft,
  repointDraft,
  deleteDraftRow,
} from "./store/drafts";
import { shapeMessage } from "./gmail/shape";
import { notFoundError } from "./gmail/errors";
import type { GmailDraft } from "./gmail/types";

export { prepareSend };

function shapeDraft(db: Database, draftId: string, messageId: string): GmailDraft {
  const row = getMessageRow(db, messageId)!;
  return { id: draftId, message: shapeMessage(row, getLabelIds(db, messageId), "full") };
}

/** Create a draft (DRAFT label, own draft id ≠ message id). Sync; in a tx. */
export function commitCreateDraft(db: Database, prep: PreparedSend): GmailDraft {
  const messageId = newMessageId();
  const threadId = resolveThreadId(db, prep, messageId);
  persistPrepared(db, prep, {
    id: messageId,
    threadId,
    labels: ["DRAFT"],
    internalDate: Date.now(),
  });
  const draftId = newDraftId();
  insertDraft(db, draftId, messageId);
  bumpMessageHistory(db, [messageId]);
  return shapeDraft(db, draftId, messageId);
}

/** Update a draft — assigns a NEW message id (Gmail semantics). Sync; in a tx. */
export function commitUpdateDraft(db: Database, draftId: string, prep: PreparedSend): GmailDraft {
  const draft = getDraftRow(db, draftId);
  if (!draft) throw notFoundError("Draft not found.");
  const oldRow = getMessageRow(db, draft.message_id);
  const threadId = oldRow?.thread_id ?? newMessageId();
  if (messageExists(db, draft.message_id)) deleteMessage(db, draft.message_id);

  const newId = newMessageId();
  persistPrepared(db, prep, {
    id: newId,
    threadId,
    labels: ["DRAFT"],
    internalDate: Date.now(),
  });
  repointDraft(db, draftId, newId);
  bumpMessageHistory(db, [newId]);
  return shapeDraft(db, draftId, newId);
}

/** Send a draft — deletes the draft, sends its content as a NEW message. */
export function commitSendDraft(db: Database, draftId: string, prep: PreparedSend) {
  const draft = getDraftRow(db, draftId);
  if (!draft) throw notFoundError("Draft not found.");
  if (messageExists(db, draft.message_id)) deleteMessage(db, draft.message_id);
  deleteDraftRow(db, draftId);
  return commitSend(db, prep); // new id, SENT label, outbox
}
