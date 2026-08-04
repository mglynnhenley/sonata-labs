"use client";

import { Mrkdwn } from "./Mrkdwn";
import { Blocks } from "./Blocks";
import { EMOJI } from "./emoji";
import type { Directories, UiMessage } from "./types";

// A message row in Slack's layout: 36px avatar gutter, author line only on the
// first message of a group, continuations hang-indented into the same gutter.
// Hover reveals the action bar and the timestamp on continuations.

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
}

function relativeLabel(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function DayDivider({ label }: { label: string }) {
  return (
    <div className="relative my-3 flex items-center justify-center">
      <div className="absolute inset-x-0 top-1/2 h-px bg-[#e8e8e8]" />
      <span className="relative rounded-[12px] border border-[#e8e8e8] bg-white px-3 py-[3px] text-[13px] font-bold text-[#1d1c1d]">
        {label}
      </span>
    </div>
  );
}

function ReactionPill({
  name,
  count,
  reactedBySelf,
  onToggle,
}: {
  name: string;
  count: number;
  reactedBySelf: boolean;
  onToggle: () => void;
}) {
  const glyph = EMOJI[name];
  return (
    <button
      onClick={onToggle}
      title={`:${name}:`}
      className={[
        "flex h-[22px] items-center gap-1 rounded-[11px] border px-[7px] text-[12px] font-medium transition-colors",
        reactedBySelf
          ? "border-[#1d9bd1] bg-[#e8f5fa] text-[#1264a3]"
          : "border-[#e8e8e8] bg-[#f8f8f8] text-[#616061] hover:border-[#c9c9c9]",
      ].join(" ")}
    >
      <span className="text-[13px] leading-none">{glyph ?? `:${name}:`}</span>
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

function ActionBar({
  onReact,
  onReply,
}: {
  onReact: () => void;
  onReply: () => void;
}) {
  return (
    <div className="absolute -top-[14px] right-4 hidden overflow-hidden rounded-[6px] border border-[#e8e8e8] bg-white shadow-[0_1px_3px_rgba(0,0,0,.12)] group-hover:flex">
      {[
        { title: "Add reaction", glyph: "😀", onClick: onReact },
        { title: "Reply in thread", glyph: "💬", onClick: onReply },
        { title: "More actions", glyph: "⋯", onClick: () => {} },
      ].map((b) => (
        <button
          key={b.title}
          title={b.title}
          onClick={b.onClick}
          className="grid size-[28px] place-items-center text-[13px] hover:bg-[#f8f8f8]"
        >
          {b.glyph}
        </button>
      ))}
    </div>
  );
}

export function Message({
  msg,
  directories,
  onOpenThread,
  onToggleReaction,
  compact = false,
}: {
  msg: UiMessage;
  directories?: Directories;
  onOpenThread?: (ts: string) => void;
  onToggleReaction?: (ts: string, name: string, reacted: boolean) => void;
  /** Thread panes render replies without thread teasers. */
  compact?: boolean;
}) {
  return (
    <div
      className="group relative px-5 py-[3px] hover:bg-[#f8f8f8]"
      data-ts={msg.ts}
    >
      <ActionBar
        onReact={() => onToggleReaction?.(msg.ts, "thumbsup", msg.reactions.some((r) => r.name === "thumbsup" && r.reactedBySelf))}
        onReply={() => onOpenThread?.(msg.ts)}
      />
      <div className="flex gap-2">
        {/* Avatar gutter (36px + 8px gap) — continuations show time on hover */}
        <div className="w-[36px] shrink-0">
          {msg.continuation ? (
            <span className="hidden pt-[3px] text-right text-[11px] leading-[22px] text-[#616061] group-hover:block">
              {timeLabel(msg.timeMs).replace(/\s?[AP]M$/, "")}
            </span>
          ) : (
            <span
              className="mt-[2px] grid size-[36px] place-items-center rounded-[4px] text-[15px] font-bold text-white"
              style={{ background: msg.author.color }}
            >
              {msg.author.initials}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {!msg.continuation && (
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-bold leading-[22px] text-[#1d1c1d] hover:underline">
                {msg.author.realName}
              </span>
              {msg.author.isBot && (
                <span className="rounded-[2px] bg-[#e8e8e8] px-[3px] text-[10px] font-bold uppercase leading-[14px] tracking-wide text-[#616061]">
                  app
                </span>
              )}
              <span className="text-[12px] leading-[22px] text-[#616061] hover:underline">
                {timeLabel(msg.timeMs)}
              </span>
              {msg.pinned && (
                <span className="text-[11px] text-[#616061]" title="Pinned to this channel">
                  📌 Pinned
                </span>
              )}
              {msg.isSandboxCreated && (
                <span
                  className="rounded-[3px] bg-[#fff8e1] px-[4px] text-[10px] font-semibold leading-[15px] text-[#946f00]"
                  title="Created inside the sandbox by an agent"
                >
                  agent
                </span>
              )}
            </div>
          )}

          {/* Block Kit supersedes `text` when present (text is the fallback
              for notifications), matching how Slack renders it. */}
          {msg.blocks?.length ? (
            <>
              <Blocks blocks={msg.blocks} directories={directories} />
              {msg.edited && <span className="text-[11px] text-[#616061]">(edited)</span>}
            </>
          ) : (
            <div className="whitespace-pre-wrap break-words text-[15px] leading-[1.46] text-[#1d1c1d]">
              <Mrkdwn text={msg.text} directories={directories} />
              {msg.edited && <span className="ml-1 text-[11px] text-[#616061]">(edited)</span>}
            </div>
          )}

          {msg.files.length > 0 && (
            <div className="mt-1 space-y-1">
              {msg.files.map((f) => (
                <div
                  key={f.id}
                  className="flex max-w-[420px] items-center gap-2 rounded-[6px] border border-[#e8e8e8] p-2 hover:bg-white"
                >
                  <span className="grid size-[32px] shrink-0 place-items-center rounded-[4px] bg-[#f6f6f6] text-[14px]">
                    📄
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-bold text-[#1d1c1d] hover:underline">
                      {f.title}
                    </span>
                    <span className="block truncate text-[11px] uppercase text-[#616061]">
                      {f.filetype} · {formatSize(f.size)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {msg.reactions.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {msg.reactions.map((r) => (
                <ReactionPill
                  key={r.name}
                  name={r.name}
                  count={r.count}
                  reactedBySelf={r.reactedBySelf}
                  onToggle={() => onToggleReaction?.(msg.ts, r.name, r.reactedBySelf)}
                />
              ))}
              <button
                title="Add reaction"
                onClick={() => onToggleReaction?.(msg.ts, "thumbsup", false)}
                className="hidden h-[22px] items-center rounded-[11px] border border-[#e8e8e8] bg-[#f8f8f8] px-[7px] text-[12px] text-[#616061] hover:border-[#c9c9c9] group-hover:flex"
              >
                ＋
              </button>
            </div>
          )}

          {!compact && msg.replyCount > 0 && (
            <button
              onClick={() => onOpenThread?.(msg.ts)}
              className="mt-1 flex items-center gap-2 rounded-[6px] border border-transparent px-1 py-[2px] hover:border-[#e8e8e8] hover:bg-white"
            >
              <span className="flex -space-x-1">
                {msg.replyUsers.map((u) => (
                  <span
                    key={u.id}
                    className="grid size-[20px] place-items-center rounded-[4px] text-[9px] font-bold text-white ring-2 ring-white"
                    style={{ background: u.color }}
                  >
                    {u.initials}
                  </span>
                ))}
              </span>
              <span className="text-[13px] font-bold text-[#1264a3] hover:underline">
                {msg.replyCount} {msg.replyCount === 1 ? "reply" : "replies"}
              </span>
              {msg.latestReplyMs && (
                <span className="text-[12px] text-[#616061]">
                  Last reply {relativeLabel(msg.latestReplyMs)}
                </span>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
