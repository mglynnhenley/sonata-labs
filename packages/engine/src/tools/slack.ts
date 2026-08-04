import type { TwinHttp } from "../http";
import { createSlackClient } from "../slackClient";
import { fn, int, str, type EngineTool, type ToolInput } from "./types";

// The eight Slack tools. Read three ways (channel, thread, search), write three
// ways (post, reply, react), plus the one lookup that stops an agent guessing who
// "@dana" is.
//
// Deliberately no chat.update, no chat.delete, no conversations.create: the
// episodes are about doing the day's work, and an agent that can rewrite history
// makes the diff — the evidence — unreliable. Anything it says, it said.

const MAX_TEXT = 600;

interface SlackMessage {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name?: string; count?: number }>;
}

function digest(m: SlackMessage): Record<string, unknown> {
  return {
    ts: m.ts,
    user: m.user,
    text: (m.text ?? "").slice(0, MAX_TEXT),
    ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
    ...(m.reply_count ? { replyCount: m.reply_count } : {}),
    ...(m.reactions?.length
      ? { reactions: m.reactions.map((r) => `${r.name}:${r.count ?? 0}`) }
      : {}),
  };
}

export function slackTools(http: TwinHttp): EngineTool[] {
  const slack = createSlackClient(http);

  return [
    {
      name: "list_channels",
      twin: "slack",
      isMutation: false,
      def: fn(
        "list_channels",
        "List the channels in the workspace, with what each one is for. Start here to find " +
          "where a conversation belongs.",
        { type: "object", properties: {} },
      ),
      async run() {
        const channels = await slack.listChannels();
        return {
          channels: channels.map((c) => ({
            id: c.id,
            name: c.name,
            purpose: c.purpose?.value ?? "",
            isPrivate: c.is_private === true,
            memberCount: c.num_members ?? 0,
          })),
        };
      },
    },
    {
      name: "get_channel_history",
      twin: "slack",
      isMutation: false,
      def: fn(
        "get_channel_history",
        "Read the recent messages in a channel, newest first. Thread replies are not " +
          "included — call get_thread_replies for those.",
        {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel name or id, e.g. 'ops'." },
            limit: { type: "integer", description: "Default 30." },
          },
          required: ["channel"],
        },
      ),
      async run(input: ToolInput) {
        const channel = await slack.resolveChannel(str(input.channel));
        const res = await slack.call<{ messages?: SlackMessage[] }>("conversations.history", {
          channel,
          limit: int(input.limit, 30),
        });
        return { channel, messages: (res.messages ?? []).map(digest) };
      },
    },
    {
      name: "get_thread_replies",
      twin: "slack",
      isMutation: false,
      def: fn(
        "get_thread_replies",
        "Read a whole thread: the parent message and every reply. Use this before answering " +
          "in a thread — the answer is often already there.",
        {
          type: "object",
          properties: {
            channel: { type: "string" },
            threadTs: { type: "string", description: "The ts of the thread's parent message." },
          },
          required: ["channel", "threadTs"],
        },
      ),
      async run(input: ToolInput) {
        const channel = await slack.resolveChannel(str(input.channel));
        const res = await slack.call<{ messages?: SlackMessage[] }>("conversations.replies", {
          channel,
          ts: str(input.threadTs),
        });
        return { channel, messages: (res.messages ?? []).map(digest) };
      },
    },
    {
      name: "get_user",
      twin: "slack",
      isMutation: false,
      def: fn(
        "get_user",
        "Look up who a Slack user is: real name, title, email. Accepts a user id or an " +
          "email address.",
        {
          type: "object",
          properties: { user: { type: "string", description: "User id or email address." } },
          required: ["user"],
        },
      ),
      async run(input: ToolInput) {
        const who = str(input.user);
        // An email is the join key between the three twins, so an agent that has
        // only ever seen someone's mail address can still find them here.
        const res = who.includes("@")
          ? await slack.call<{ user?: Record<string, unknown> }>("users.lookupByEmail", {
              email: who,
            })
          : await slack.call<{ user?: Record<string, unknown> }>("users.info", { user: who });
        const u = (res.user ?? {}) as Record<string, unknown>;
        const profile = (u.profile ?? {}) as Record<string, unknown>;
        return {
          id: u.id,
          name: profile.real_name ?? u.real_name ?? u.name,
          title: profile.title ?? "",
          email: profile.email ?? "",
        };
      },
    },
    {
      name: "search_messages",
      twin: "slack",
      isMutation: false,
      def: fn(
        "search_messages",
        "Search the workspace. Supports Slack modifiers like 'in:#ops' and 'from:@dana'. " +
          "Use it to find what was already said about something before you say it again.",
        {
          type: "object",
          properties: {
            query: { type: "string" },
            count: { type: "integer", description: "Default 20." },
          },
          required: ["query"],
        },
      ),
      async run(input: ToolInput) {
        const res = await slack.call<{
          messages?: { matches?: Array<Record<string, unknown>> };
        }>("search.messages", { query: str(input.query), count: int(input.count, 20) });
        const matches = res.messages?.matches ?? [];
        return {
          matches: matches.map((m) => ({
            ts: m.ts,
            user: m.username ?? m.user,
            channel: (m.channel as { name?: string } | undefined)?.name,
            text: str(m.text).slice(0, MAX_TEXT),
          })),
        };
      },
    },
    {
      name: "send_message",
      twin: "slack",
      isMutation: true,
      def: fn(
        "send_message",
        "Post a message to a channel. This is visible to everyone in it — say it here when " +
          "the team needs to know, not only the person who emailed.",
        {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel name or id." },
            text: { type: "string" },
          },
          required: ["channel", "text"],
        },
      ),
      async run(input: ToolInput) {
        const channel = await slack.resolveChannel(str(input.channel));
        const res = await slack.call<{ ts?: string; channel?: string }>("chat.postMessage", {
          channel,
          text: str(input.text),
        });
        return { ts: res.ts, channel: res.channel ?? channel, posted: true };
      },
    },
    {
      name: "reply_in_thread",
      twin: "slack",
      isMutation: true,
      def: fn(
        "reply_in_thread",
        "Reply inside an existing thread rather than starting a new one in the channel. " +
          "Keeps an answer attached to the question it answers.",
        {
          type: "object",
          properties: {
            channel: { type: "string" },
            threadTs: { type: "string", description: "The ts of the message you are replying to." },
            text: { type: "string" },
          },
          required: ["channel", "threadTs", "text"],
        },
      ),
      async run(input: ToolInput) {
        const channel = await slack.resolveChannel(str(input.channel));
        const res = await slack.call<{ ts?: string; channel?: string }>("chat.postMessage", {
          channel,
          text: str(input.text),
          thread_ts: str(input.threadTs),
        });
        return { ts: res.ts, channel: res.channel ?? channel, threadTs: str(input.threadTs) };
      },
    },
    {
      name: "add_reaction",
      twin: "slack",
      isMutation: true,
      def: fn(
        "add_reaction",
        "React to a message with an emoji — the cheapest way to acknowledge something " +
          "without adding noise to the channel.",
        {
          type: "object",
          properties: {
            channel: { type: "string" },
            ts: { type: "string", description: "The ts of the message to react to." },
            emoji: { type: "string", description: "Emoji name without colons, e.g. 'eyes'." },
          },
          required: ["channel", "ts", "emoji"],
        },
      ),
      async run(input: ToolInput) {
        const channel = await slack.resolveChannel(str(input.channel));
        const emoji = str(input.emoji).replace(/:/g, "");
        await slack.call("reactions.add", { channel, timestamp: str(input.ts), name: emoji });
        return { channel, ts: str(input.ts), emoji, reacted: true };
      },
    },
  ];
}
