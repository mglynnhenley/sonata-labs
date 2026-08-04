import type { Database } from "better-sqlite3";
import { getMessage, insertMessage } from "../store/messages";
import { addReaction } from "../store/reactions";
import { getSelf } from "../store/meta";
import { mintTs } from "../slack/ts";
import { channelTypeOf, messagePosted, reactionAdded } from "../events/events";
import { BadRequestError } from "./auth";
import { messageRawJson } from "./raw";
import { normalizeEmoji, resolveAtMs, resolveChannel, resolveUserId } from "./resolve";
import type { InjectRequest, InjectedSlackEvent } from "./types";

// One world event into the workspace. The engine calls this once per scripted
// beat and once per improvised director reply, and uses the returned ts to hang
// the next beat off this one.
//
// Written straight through the store layer rather than the Web API methods,
// because the methods audit-log: the audit log is the AGENT's record and grading
// reads it, so a coworker's message must leave no trace in it. Events ARE
// emitted — a subscriber that misses the world's messages is not a Slack twin.

const KINDS = new Set(["message", "thread_reply", "reaction"]);

export function parseInjectRequest(body: unknown): InjectRequest {
  if (typeof body !== "object" || body === null) {
    throw new BadRequestError("body must be a JSON object");
  }
  const b = body as { kind?: string };
  if (!b.kind || !KINDS.has(b.kind)) {
    throw new BadRequestError(
      `unsupported kind '${String(b.kind)}' — slack injects 'message', 'thread_reply' or 'reaction'`,
    );
  }
  return body as InjectRequest;
}

export function injectEvent(db: Database, req: InjectRequest): InjectedSlackEvent {
  const atMs = resolveAtMs(req, "inject");
  const channel = resolveChannel(db, req.channel);
  const user = resolveUserId(db, req.user);
  const teamId = getSelf(db).teamId;

  if (req.kind === "reaction") {
    const targetTs = req.ts ?? req.threadTs;
    const target = targetTs ? getMessage(db, channel.id, targetTs) : undefined;
    if (!target) {
      throw new BadRequestError(`message '${String(targetTs)}' not found in ${channel.id}`);
    }
    const emoji = normalizeEmoji(req.emoji);
    addReaction(db, channel.id, target.ts, emoji, user);
    reactionAdded({
      user,
      reaction: emoji,
      channel: channel.id,
      ts: target.ts,
      itemUser: target.user,
    });
    // A reaction has no id of its own; the target's ts is what a criterion or a
    // follow-up beat would name.
    return { twin: "slack", id: target.ts, containerId: channel.id };
  }

  if (typeof req.text !== "string" || !req.text) {
    throw new BadRequestError("text is required");
  }

  let threadTs: string | null = null;
  if (req.kind === "thread_reply") {
    const parent = req.threadTs ? getMessage(db, channel.id, req.threadTs) : undefined;
    if (!parent) {
      throw new BadRequestError(`thread '${String(req.threadTs)}' not found in ${channel.id}`);
    }
    // Replying to a reply lands in the same thread, as Slack does.
    threadTs = parent.thread_ts ?? parent.ts;
  }

  const post = db.transaction(() => {
    // Inside the transaction: mintTs reads MAX(ts), and two beats landing on the
    // same channel in one tick must not be handed the same id.
    const ts = mintTs(db, channel.id, atMs);
    insertMessage(db, {
      channelId: channel.id,
      ts,
      threadTs,
      user,
      text: req.text,
      rawJson: messageRawJson({ user, text: req.text, ts, teamId }),
      isSandboxCreated: false,
    });
    return ts;
  });

  const ts = post();
  messagePosted({
    channel: channel.id,
    ts,
    user,
    text: req.text,
    threadTs,
    channelType: channelTypeOf(channel),
  });

  return {
    twin: "slack",
    id: ts,
    containerId: channel.id,
    threadTs: threadTs ?? undefined,
  };
}
