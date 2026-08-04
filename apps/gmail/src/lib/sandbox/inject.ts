import type { Database } from "better-sqlite3";
import { getProfileEmail } from "../store/meta";
import { BadRequestError } from "./auth";
import { joinAddrs, resolveAtMs, resolveThread, writeEmail } from "./mail";
import type { InjectEmailRequest, InjectedEmail } from "./types";

// One world event into the mailbox. The engine calls this once per beat and once
// per improvised director reply, and uses the returned ids to thread the next
// beat onto this one.

/** Injected mail is mail that just arrived; the agent has to notice it. */
const DEFAULT_LABELS = ["INBOX", "UNREAD"];

export function parseInjectRequest(body: unknown): InjectEmailRequest {
  if (typeof body !== "object" || body === null) {
    throw new BadRequestError("body must be a JSON object");
  }
  const b = body as Partial<InjectEmailRequest>;
  if (b.kind !== "email") {
    throw new BadRequestError(`unsupported kind '${String(b.kind)}' — gmail injects 'email'`);
  }
  if (!b.from) throw new BadRequestError("from is required");
  if (typeof b.subject !== "string") throw new BadRequestError("subject is required");
  if (typeof b.body !== "string") throw new BadRequestError("body is required");
  return b as InjectEmailRequest;
}

export function injectEmail(db: Database, req: InjectEmailRequest): InjectedEmail {
  const atMs = resolveAtMs(req, "inject");
  const to = joinAddrs(req.to) || getProfileEmail(db);
  const cc = joinAddrs(req.cc);

  const write = db.transaction(() => {
    // An unresolvable threadRef posts standalone rather than throwing: the beat
    // it named may simply never have fired, and one orphaned follow-up is a far
    // smaller wound to the day than a failed injection.
    const anchor = req.threadRef ? resolveThread(db, req.threadRef) : null;
    return writeEmail(db, {
      from: req.from,
      to,
      cc: cc || undefined,
      subject: req.subject,
      body: req.body,
      atMs,
      labelIds: req.labels?.length ? req.labels : DEFAULT_LABELS,
      threadId: anchor?.threadId,
      inReplyTo: anchor?.inReplyTo,
    });
  });

  const written = write();
  return {
    twin: "gmail",
    id: written.id,
    containerId: written.threadId,
    rfc822MessageId: written.rfc822MessageId,
    historyId: written.historyId,
    internalDate: written.internalDate,
  };
}
