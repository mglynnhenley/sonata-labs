import { emit, type SlackEvent } from "./bus";

// Slack event payload builders. Shapes follow the Events API docs so a Bolt
// app (or anything written against Slack's schemas) can consume them unchanged.
// Kept in one place so emitters stay consistent and typo-free.

export function messagePosted(args: {
  channel: string;
  ts: string;
  user: string;
  text: string;
  threadTs?: string | null;
  channelType: string;
}): void {
  const event: SlackEvent = {
    type: "message",
    channel: args.channel,
    user: args.user,
    text: args.text,
    ts: args.ts,
    event_ts: args.ts,
    channel_type: args.channelType,
  };
  if (args.threadTs) event.thread_ts = args.threadTs;
  emit(event, { eventTs: args.ts });
}

export function messageChanged(args: {
  channel: string;
  ts: string;
  user: string;
  text: string;
  channelType: string;
  editedTs: string;
}): void {
  emit(
    {
      type: "message",
      subtype: "message_changed",
      channel: args.channel,
      channel_type: args.channelType,
      ts: args.editedTs,
      event_ts: args.editedTs,
      message: {
        type: "message",
        user: args.user,
        text: args.text,
        ts: args.ts,
        edited: { user: args.user, ts: args.editedTs },
      },
      previous_message: { type: "message", ts: args.ts },
    },
    { eventTs: args.ts },
  );
}

export function messageDeleted(args: {
  channel: string;
  ts: string;
  channelType: string;
  deletedTs: string;
}): void {
  emit(
    {
      type: "message",
      subtype: "message_deleted",
      channel: args.channel,
      channel_type: args.channelType,
      ts: args.deletedTs,
      event_ts: args.deletedTs,
      deleted_ts: args.ts,
      previous_message: { type: "message", ts: args.ts },
    },
    { eventTs: args.ts },
  );
}

function reactionEvent(
  type: "reaction_added" | "reaction_removed",
  args: { user: string; reaction: string; channel: string; ts: string; itemUser?: string | null },
): void {
  emit(
    {
      type,
      user: args.user,
      reaction: args.reaction,
      item_user: args.itemUser ?? undefined,
      item: { type: "message", channel: args.channel, ts: args.ts },
      event_ts: (Date.now() / 1000).toFixed(6),
    },
    { eventTs: args.ts },
  );
}

export const reactionAdded = (a: Parameters<typeof reactionEvent>[1]) =>
  reactionEvent("reaction_added", a);
export const reactionRemoved = (a: Parameters<typeof reactionEvent>[1]) =>
  reactionEvent("reaction_removed", a);

export function channelCreated(args: {
  id: string;
  name: string;
  creator: string;
  created: number;
}): void {
  emit({
    type: "channel_created",
    channel: {
      id: args.id,
      name: args.name,
      created: args.created,
      creator: args.creator,
    },
    event_ts: (Date.now() / 1000).toFixed(6),
  });
}

export function memberJoined(args: {
  user: string;
  channel: string;
  channelType: string;
  inviter?: string;
}): void {
  const event: SlackEvent = {
    type: "member_joined_channel",
    user: args.user,
    channel: args.channel,
    channel_type: args.channelType,
    event_ts: (Date.now() / 1000).toFixed(6),
  };
  if (args.inviter) event.inviter = args.inviter;
  emit(event);
}

export function memberLeft(args: {
  user: string;
  channel: string;
  channelType: string;
}): void {
  emit({
    type: "member_left_channel",
    user: args.user,
    channel: args.channel,
    channel_type: args.channelType,
    event_ts: (Date.now() / 1000).toFixed(6),
  });
}

function pinEvent(type: "pin_added" | "pin_removed", args: {
  user: string;
  channel: string;
  ts: string;
}): void {
  emit({
    type,
    user: args.user,
    channel_id: args.channel,
    item: { type: "message", channel: args.channel, message: { ts: args.ts } },
    event_ts: (Date.now() / 1000).toFixed(6),
  });
}

export const pinAdded = (a: Parameters<typeof pinEvent>[1]) => pinEvent("pin_added", a);
export const pinRemoved = (a: Parameters<typeof pinEvent>[1]) => pinEvent("pin_removed", a);

export function channelArchive(args: {
  channel: string;
  user: string;
  archived: boolean;
}): void {
  emit({
    type: args.archived ? "channel_archive" : "channel_unarchive",
    channel: args.channel,
    user: args.user,
    event_ts: (Date.now() / 1000).toFixed(6),
  });
}

/** Slack's channel_type discriminator, derived from the conversation row. */
export function channelTypeOf(row: {
  is_im: number;
  is_mpim: number;
  is_private: number;
}): string {
  if (row.is_im) return "im";
  if (row.is_mpim) return "mpim";
  if (row.is_private) return "group";
  return "channel";
}
