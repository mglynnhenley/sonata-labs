"use client";

import { useEffect, useRef } from "react";
import { Message, DayDivider } from "./Message";
import type { ChannelData, Directories } from "./types";

function ChannelIcon({ kind }: { kind: ChannelData["channel"]["kind"] }) {
  if (kind === "channel") return <span className="text-[18px] font-light text-[#1d1c1d]">#</span>;
  if (kind === "private")
    return (
      <svg viewBox="0 0 16 16" className="size-[15px]" aria-hidden>
        <path d="M11 7V5a3 3 0 10-6 0v2H4v7h8V7h-1zM6.2 5a1.8 1.8 0 113.6 0v2H6.2V5z" fill="currentColor" />
      </svg>
    );
  return <span className="text-[13px]">{kind === "mpim" ? "👥" : "💬"}</span>;
}

export function ChannelPane({
  data,
  directories,
  onOpenThread,
  onToggleReaction,
  onSend,
  sending,
}: {
  data: ChannelData;
  directories?: Directories;
  onOpenThread: (ts: string) => void;
  onToggleReaction: (ts: string, name: string, reacted: boolean) => void;
  onSend: (text: string) => void;
  sending: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastTs = data.messages.at(-1)?.ts;

  // Keep the view pinned to the newest message as agent writes stream in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data.channel.id, lastTs]);

  const submit = () => {
    const el = inputRef.current;
    if (!el) return;
    const text = el.value.trim();
    if (!text) return;
    onSend(text);
    el.value = "";
    el.style.height = "auto";
  };

  const { channel } = data;
  const title = channel.kind === "im" ? channel.name : channel.name;

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-white">
      {/* Channel header */}
      <header className="flex items-center justify-between border-b border-[#e8e8e8] px-5 py-[10px]">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="flex items-center gap-1 truncate text-[18px] font-black leading-tight text-[#1d1c1d]">
            <ChannelIcon kind={channel.kind} />
            <span className="truncate">{title}</span>
            {channel.isArchived && (
              <span className="ml-1 rounded-[3px] bg-[#f6f6f6] px-[5px] text-[11px] font-semibold text-[#616061]">
                archived
              </span>
            )}
          </h2>
          {channel.topic && (
            <p className="hidden min-w-0 truncate text-[13px] text-[#616061] md:block">
              {channel.topic}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[13px] text-[#616061]">
          {channel.kind !== "im" && (
            <span className="flex items-center gap-1 rounded-[4px] border border-[#e8e8e8] px-2 py-[3px]">
              <span>👤</span>
              <span className="tabular-nums">{channel.memberCount}</span>
            </span>
          )}
        </div>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-3">
        {data.messages.length === 0 ? (
          <p className="px-5 py-8 text-[14px] text-[#616061]">No messages yet.</p>
        ) : (
          data.messages.map((m) => (
            <div key={m.ts}>
              {m.dayDivider && <DayDivider label={m.dayDivider} />}
              <Message
                msg={m}
                directories={directories}
                onOpenThread={onOpenThread}
                onToggleReaction={onToggleReaction}
              />
            </div>
          ))
        )}
      </div>

      {/* Composer */}
      <div className="px-5 pb-5 pt-1">
        <div className="rounded-[8px] border border-[#8d8d8e] focus-within:border-[#1d1c1d] focus-within:shadow-[0_0_0_1px_#1d1c1d]">
          <div className="flex items-center gap-3 border-b border-[#e8e8e8] px-3 py-[6px] text-[13px] text-[#616061]">
            {["𝐁", "𝐼", "S̶", "🔗", "≡", "</>"].map((g, i) => (
              <button key={i} className="rounded px-1 hover:bg-[#f6f6f6]" tabIndex={-1}>
                {g}
              </button>
            ))}
          </div>
          <textarea
            ref={inputRef}
            rows={1}
            disabled={channel.isArchived || sending}
            placeholder={
              channel.isArchived
                ? "This channel is archived"
                : `Message ${channel.kind === "channel" ? "#" : ""}${title}`
            }
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="block max-h-[180px] w-full resize-none px-3 py-2 text-[15px] leading-[1.46] text-[#1d1c1d] outline-none placeholder:text-[#616061] disabled:bg-[#f6f6f6]"
          />
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <div className="flex items-center gap-1 text-[13px] text-[#616061]">
              {["➕", "😀", "@"].map((g) => (
                <button key={g} className="rounded px-1 hover:bg-[#f6f6f6]" tabIndex={-1}>
                  {g}
                </button>
              ))}
            </div>
            <button
              onClick={submit}
              disabled={channel.isArchived || sending}
              title="Send"
              className="grid size-[26px] place-items-center rounded-[4px] bg-[#007a5a] text-white transition hover:bg-[#148567] disabled:bg-[#e8e8e8] disabled:text-[#9b9b9b]"
            >
              <svg viewBox="0 0 16 16" className="size-[13px]" aria-hidden>
                {/* Paper plane, pointing right (Slack's send affordance). */}
                <path d="M1.8 1.6L15 8 1.8 14.4 4.4 8 1.8 1.6z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
