import {
  slackIdOf,
  type AgentTrace,
  type BeatBody,
  type EpisodeSpec,
  type InjectContext,
  type InjectedRef,
  type JudgeStep,
  type SlackDiff,
  type SlackSnapshot,
  type TwinAdapter,
  type TwinAuditRow,
  type TwinDiff,
  type TwinHealth,
  type TwinSnapshot,
} from "@sonata/core";
import { TwinHttp, TwinHttpError, type TwinHttpOptions } from "../http";
import { createSlackClient, type SlackChannel } from "../slackClient";
import { projectTwinTrace } from "../project";
import {
  auditViaActivity,
  byKey,
  clip,
  healthViaApi,
  resetViaApi,
  seedViaApi,
} from "./shared";

// The Slack twin, behind @sonata/core's TwinAdapter.
//
// Capture goes through the Web API the agent uses (conversations.list /
// .history), and follows the Gmail snapshot's token discipline exactly: message
// *digests*, never bodies; reactions as counted names; and `unchangedCount` as a
// number rather than a list, because a workspace is overwhelmingly untouched by
// any one workday and spelling out the untouched part is how a judge prompt goes
// from a page to a novel.
//
// Two Slack-specific notes:
//   - Errors arrive as HTTP 200 with `{ok: false, error}`, so every call goes
//     through `call()` rather than the raw client.
//   - The shared SlackSnapshot carries no read cursors. Read state in this twin
//     moves on `conversations.mark`, which the agent's toolset never calls, so a
//     cursor field would be a column of constants in every artifact.

/** Channels per snapshot. A cloned company has tens, not thousands. */
const MAX_CHANNELS = 60;

/** Recent messages captured per channel — the working window of a workday. */
const MAX_PER_CHANNEL = 60;

/** Total message digests in one snapshot, across all channels. */
const MAX_MESSAGES = 400;

const MAX_TEXT = 240;

interface SlackMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name?: string; count?: number }>;
}

export interface SlackAdapterOptions extends Omit<TwinHttpOptions, "baseUrl"> {
  baseUrl?: string;
}

export function createSlackAdapter(opts: SlackAdapterOptions = {}): TwinAdapter {
  const baseUrl = opts.baseUrl ?? process.env.SLACK_TWIN_URL ?? "http://localhost:3200";
  const http = new TwinHttp({ ...opts, baseUrl });
  const slack = createSlackClient(http, MAX_CHANNELS);

  /** One beat into the workspace. The route takes one event, not a batch. */
  async function injected(request: Record<string, unknown>): Promise<{
    id?: string;
    containerId?: string;
  }> {
    const res = await http.post<{ injected?: { id?: string; containerId?: string } }>(
      "/api/sandbox/inject",
      request,
    );
    return res.injected ?? {};
  }

  /**
   * A message ref, split into the channel it lives in and its `ts`.
   *
   * Two shapes arrive here. A ref the engine minted from an inject carries `id`
   * and `containerId` separately; a ref minted from the twin's own audit log
   * carries Slack's `target_id`, which is `"C01OPS/1720000000.000200"` — one
   * string, because that is what identifies a message in this twin. Handing that
   * whole string back as a `ts` is how every attempt by the world to reply in a
   * thread the agent started came back 400 "thread not found".
   */
  function messageRef(ref: InjectedRef): { ts: string; channel?: string } {
    const slash = ref.id.indexOf("/");
    if (slash > 0) return { ts: ref.id.slice(slash + 1), channel: ref.id.slice(0, slash) };
    return { ts: ref.id, ...(ref.containerId ? { channel: ref.containerId } : {}) };
  }

  function digest(channelId: string, channelName: string, m: SlackMessage) {
    return {
      channelId,
      channelName,
      ts: m.ts ?? "",
      user: m.user ?? m.bot_id ?? "",
      text: clip(m.text ?? "", MAX_TEXT),
      ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
      replyCount: m.reply_count ?? 0,
      // "eyes:2" rather than the user list: who reacted is rarely the point, and
      // the list is the unbounded part.
      reactions: (m.reactions ?? [])
        .map((r) => `${r.name ?? ""}:${r.count ?? 0}`)
        .sort(),
    };
  }

  return {
    name: "slack",
    baseUrl,

    health(): Promise<TwinHealth> {
      return healthViaApi(http, "slack");
    },

    async snapshot(): Promise<TwinSnapshot> {
      const channels = await slack.listChannels();
      const outChannels: SlackSnapshot["channels"] = [];
      const messages: SlackSnapshot["messages"] = [];

      for (const c of channels) {
        if (!c.id) continue;
        const name = c.name ?? c.id;
        const history = await slack.call<{ messages?: SlackMessage[] }>("conversations.history", {
          channel: c.id,
          limit: MAX_PER_CHANNEL,
        });
        const rows = history.messages ?? [];
        outChannels.push({
          id: c.id,
          name,
          isPrivate: c.is_private === true,
          memberCount: c.num_members ?? 0,
          // Messages inside the captured window, not the channel's whole history:
          // the number exists so a diff can say "three more than before", and an
          // unbounded exact count would cost a full drain of every channel.
          messageCount: rows.length,
        });
        for (const m of rows) {
          if (messages.length >= MAX_MESSAGES) break;
          messages.push(digest(c.id, name, m));
        }
      }

      return { twin: "slack", capturedAt: Date.now(), channels: outChannels, messages };
    },

    diff(before: TwinSnapshot, after: TwinSnapshot): TwinDiff {
      return diffSlack(before as SlackSnapshot, after as SlackSnapshot);
    },

    renderDiff(diff: TwinDiff): string {
      return renderSlackDiff(diff as SlackDiff);
    },

    async inject(body: BeatBody, ctx: InjectContext): Promise<InjectedRef> {
      if (body.twin !== "slack") throw new Error(`slack adapter cannot inject a ${body.twin} beat`);

      // Everything the world does in Slack goes through the sandbox route, never
      // chat.postMessage: the Web API posts as the authenticated user (the mailbox
      // owner) and writes an audit row, so using it would both put a coworker's
      // words in the owner's mouth and make the world's own move look like the
      // agent's. The engine reads that audit log to decide what the agent did.
      try {
        if (body.kind === "message") {
          const p = body.payload;
          const parent = p.threadRef ? ctx.resolve(p.threadRef) : undefined;
          // The route resolves a channel name itself, so no roster lookup here:
          // one fewer round trip, and the twin stays the only thing that decides
          // what "#ops" means.
          const res = await injected(
            parent
              ? {
                  kind: "thread_reply",
                  channel: p.channel.replace(/^#/, ""),
                  user: slackIdOf(ctx.world, p.from),
                  text: p.text,
                  threadTs: messageRef(parent).ts,
                  atISO: ctx.atISO,
                }
              : {
                  kind: "message",
                  channel: p.channel.replace(/^#/, ""),
                  user: slackIdOf(ctx.world, p.from),
                  text: p.text,
                  atISO: ctx.atISO,
                },
          );
          if (!res.id) throw new Error("slack inject returned no ts");
          return {
            twin: "slack",
            id: res.id,
            ...(res.containerId ? { containerId: res.containerId } : {}),
          };
        }

        const p = body.payload;
        const target = ctx.resolve(p.messageRef);
        if (!target) throw new Error(`reaction targets "${p.messageRef}", which nothing created`);
        const { ts, channel } = messageRef(target);
        if (!channel) {
          throw new Error(`reaction target "${p.messageRef}" has no channel to react in`);
        }
        await injected({
          kind: "reaction",
          channel,
          ts,
          user: slackIdOf(ctx.world, p.from),
          emoji: p.emoji,
          atISO: ctx.atISO,
        });
        // A reaction has no identity of its own in Slack; it belongs to the
        // message, so the handle points back at what it decorated.
        return { twin: "slack", id: ts, containerId: channel };
      } catch (err) {
        if (err instanceof TwinHttpError && err.status === 404) {
          throw new Error(
            "The slack twin has no POST /api/sandbox/inject route. Scripted beats and " +
              "director events need it: chat.postMessage would post as the mailbox owner " +
              "and log an audit row, which corrupts both the world and the agent's record.",
          );
        }
        throw err;
      }
    },

    seed(spec: EpisodeSpec): Promise<void> {
      return seedViaApi(http, "slack", spec);
    },

    reset(): Promise<void> {
      return resetViaApi(http, "episode reset");
    },

    auditSince(sinceId: number): Promise<TwinAuditRow[]> {
      return auditViaActivity(http, "slack", sinceId, { since: sinceId });
    },

    projectTrace(trace: AgentTrace): JudgeStep[] {
      return projectTwinTrace(trace, "slack");
    },
  };
}

// ---------------------------------------------------------------------------
// Diff — pure. Keyed by (channel, ts): a Slack message's ts is its identity and
// survives edits, which is exactly the case an "edited" row has to catch.
// ---------------------------------------------------------------------------

const byChannelTs = byKey<{ channelName: string; ts: string }>((m) => `${m.channelName} ${m.ts}`);

function key(m: { channelId: string; ts: string }): string {
  return `${m.channelId} ${m.ts}`;
}

export function diffSlack(before: SlackSnapshot, after: SlackSnapshot): SlackDiff {
  const beforeById = new Map(before.messages.map((m) => [key(m), m]));
  const afterKeys = new Set(after.messages.map(key));

  const posted: SlackDiff["posted"] = [];
  const edited: SlackDiff["edited"] = [];
  const deleted: SlackDiff["deleted"] = [];
  const reactionsAdded: SlackDiff["reactionsAdded"] = [];
  let unchangedCount = 0;

  for (const m of after.messages) {
    const prev = beforeById.get(key(m));
    if (!prev) {
      posted.push({
        channelName: m.channelName,
        ts: m.ts,
        user: m.user,
        text: m.text,
        ...(m.threadTs ? { threadTs: m.threadTs } : {}),
      });
      continue;
    }

    const textChanged = prev.text !== m.text;
    const newReactions = m.reactions.filter((r) => !prev.reactions.includes(r));

    if (textChanged) edited.push({ channelName: m.channelName, ts: m.ts, text: m.text });
    for (const r of newReactions) {
      const [emoji = "", count = ""] = r.split(":");
      // The snapshot counts reactions rather than naming who left them, so the
      // "user" here is the count that changed. Naming it honestly beats inventing
      // an attribution the capture never had.
      reactionsAdded.push({ channelName: m.channelName, ts: m.ts, emoji, user: `x${count}` });
    }
    if (!textChanged && newReactions.length === 0) unchangedCount++;
  }

  // A message present before and absent after was deleted — unless its channel
  // simply fell out of the capture window, which would read as a mass deletion.
  const capturedChannels = new Set(after.messages.map((m) => m.channelId));
  for (const m of before.messages) {
    if (!afterKeys.has(key(m)) && capturedChannels.has(m.channelId)) {
      deleted.push({ channelName: m.channelName, ts: m.ts });
    }
  }

  const beforeChannels = new Set(before.channels.map((c) => c.id));
  const channelsCreated = after.channels.filter((c) => !beforeChannels.has(c.id)).map((c) => c.name);

  return {
    twin: "slack",
    posted: posted.sort(byChannelTs),
    edited: edited.sort(byChannelTs),
    deleted: deleted.sort(byChannelTs),
    reactionsAdded: reactionsAdded.sort(byChannelTs),
    channelsCreated: channelsCreated.sort(),
    unchangedCount,
  };
}

export function renderSlackDiff(diff: SlackDiff): string {
  const lines: string[] = [];
  for (const c of diff.channelsCreated) lines.push(`+ created channel #${c}`);
  for (const m of diff.posted) {
    lines.push(`+ #${m.channelName} ${m.user}${m.threadTs ? " (in thread)" : ""}: ${m.text}`);
  }
  for (const m of diff.edited) lines.push(`~ #${m.channelName} ${m.ts} edited: ${m.text}`);
  for (const r of diff.reactionsAdded) {
    lines.push(`~ #${r.channelName} ${r.ts} :${r.emoji}: ${r.user}`);
  }
  for (const m of diff.deleted) lines.push(`- #${m.channelName} ${m.ts} deleted`);
  lines.push(`${diff.unchangedCount} message(s) untouched`);
  return lines.join("\n");
}
