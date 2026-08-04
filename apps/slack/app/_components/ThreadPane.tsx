"use client";

import { useRef } from "react";
import { Message } from "./Message";
import type { Directories, ThreadData } from "./types";

// Slack's right-hand thread drawer: parent, a "N replies" rule, then replies,
// each rendered without its own thread teaser.
export function ThreadPane({
  data,
  directories,
  onClose,
  onToggleReaction,
  onReply,
  sending,
}: {
  data: ThreadData;
  directories?: Directories;
  onClose: () => void;
  onToggleReaction: (ts: string, name: string, reacted: boolean) => void;
  onReply: (text: string, alsoSendToChannel: boolean) => void;
  sending: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const alsoRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const el = inputRef.current;
    if (!el) return;
    const text = el.value.trim();
    if (!text) return;
    onReply(text, !!alsoRef.current?.checked);
    el.value = "";
    el.style.height = "auto";
    if (alsoRef.current) alsoRef.current.checked = false;
  };

  return (
    <aside className="flex h-full w-[400px] shrink-0 flex-col border-l border-[#e8e8e8] bg-white">
      <header className="flex items-center justify-between border-b border-[#e8e8e8] px-4 py-[10px]">
        <div>
          <h3 className="text-[17px] font-black leading-tight text-[#1d1c1d]">Thread</h3>
          <p className="text-[12px] text-[#616061]">
            {data.channel.kind === "channel" ? "#" : ""}
            {data.channel.name}
          </p>
        </div>
        <button
          onClick={onClose}
          title="Close"
          className="grid size-[28px] place-items-center rounded-[4px] text-[15px] text-[#616061] hover:bg-[#f6f6f6]"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 overflow-y-auto py-2">
        {data.parent && (
          <Message
            msg={data.parent}
            directories={directories}
            onToggleReaction={onToggleReaction}
            compact
          />
        )}

        {data.replies.length > 0 && (
          <div className="relative my-2 flex items-center gap-2 px-5">
            <span className="text-[13px] text-[#616061]">
              {data.replies.length} {data.replies.length === 1 ? "reply" : "replies"}
            </span>
            <span className="h-px flex-1 bg-[#e8e8e8]" />
          </div>
        )}

        {data.replies.map((m) => (
          <Message
            key={m.ts}
            msg={m}
            directories={directories}
            onToggleReaction={onToggleReaction}
            compact
          />
        ))}
      </div>

      <div className="px-4 pb-4 pt-1">
        <div className="rounded-[8px] border border-[#8d8d8e] focus-within:border-[#1d1c1d] focus-within:shadow-[0_0_0_1px_#1d1c1d]">
          <textarea
            ref={inputRef}
            rows={1}
            disabled={sending}
            placeholder="Reply…"
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="block max-h-[140px] w-full resize-none px-3 py-2 text-[15px] leading-[1.46] text-[#1d1c1d] outline-none placeholder:text-[#616061]"
          />
          <div className="flex items-center justify-end px-2 pb-2">
            <button
              onClick={submit}
              disabled={sending}
              title="Send reply"
              className="grid size-[26px] place-items-center rounded-[4px] bg-[#007a5a] text-white transition hover:bg-[#148567] disabled:bg-[#e8e8e8] disabled:text-[#9b9b9b]"
            >
              <svg viewBox="0 0 16 16" className="size-[13px]" aria-hidden>
                <path d="M1.8 1.6L15 8 1.8 14.4 4.4 8 1.8 1.6z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>
        <label className="mt-2 flex items-center gap-2 text-[13px] text-[#1d1c1d]">
          <input ref={alsoRef} type="checkbox" className="size-[15px] accent-[#1264a3]" />
          Also send to {data.channel.kind === "channel" ? "#" : ""}
          {data.channel.name}
        </label>
      </div>
    </aside>
  );
}
