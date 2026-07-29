"use client";

import { useState } from "react";
import type { ThreadView, ThreadMessageView } from "./types";
import { fullDate, smartDate } from "./types";

export function ThreadPane({
  thread,
  onBack,
}: {
  thread: ThreadView | null;
  onBack: () => void;
}) {
  if (!thread) {
    return <div className="flex h-40 items-center justify-center text-sm text-[#5f6368]">Loading…</div>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex h-12 shrink-0 items-center gap-1 px-3 text-[#5f6368]">
        <button onClick={onBack} className="rounded-full p-2 hover:bg-[#e9eef6]" title="Back">
          <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        </button>
        {["archive", "report", "delete", "mark_email_unread"].map((ic) => (
          <button key={ic} className="rounded-full p-2 hover:bg-[#e9eef6]">
            <span className="material-symbols-outlined text-[20px]">{ic}</span>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto gm-scroll px-6 pb-16">
        {/* Subject header */}
        <div className="flex items-center gap-3 py-4">
          <h1 className="text-[22px] font-normal text-[#202124]">{thread.subject}</h1>
          {thread.labels.map((l) => (
            <span
              key={l.name}
              className="rounded px-1.5 py-[1px] text-[11px] font-medium"
              style={{ color: l.textColor, backgroundColor: l.backgroundColor }}
            >
              {l.name}
            </span>
          ))}
        </div>

        {thread.messages.map((m, i) => (
          <MessageCard key={m.id} m={m} defaultOpen={i === thread.messages.length - 1} />
        ))}

        {/* Reply / Forward chips */}
        <div className="mt-6 flex gap-3">
          <button className="flex items-center gap-2 rounded-full border border-[#dadce0] px-6 py-2 text-sm text-[#3c4043] hover:bg-[#f6fafe] hover:shadow-sm">
            <span className="material-symbols-outlined text-[18px]">reply</span> Reply
          </button>
          <button className="flex items-center gap-2 rounded-full border border-[#dadce0] px-6 py-2 text-sm text-[#3c4043] hover:bg-[#f6fafe] hover:shadow-sm">
            <span className="material-symbols-outlined text-[18px]">forward</span> Forward
          </button>
        </div>
      </div>
    </div>
  );
}

const AVATAR_COLORS = ["#1a73e8", "#d93025", "#188038", "#e37400", "#9334e6", "#12b5cb", "#a8a116"];
function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function MessageCard({ m, defaultOpen }: { m: ThreadMessageView; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  if (!open) {
    return (
      <div
        onClick={() => setOpen(true)}
        className="mb-2 flex cursor-pointer items-center gap-3 rounded-lg border border-[#f1f3f4] px-4 py-3 text-[14px] hover:shadow-sm"
      >
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white"
          style={{ backgroundColor: colorFor(m.fromAddr) }}
        >
          {m.fromInitial}
        </div>
        <span className="font-medium text-[#202124]">{m.fromName}</span>
        <span className="min-w-0 flex-1 truncate text-[#5f6368]">{m.snippet}</span>
        <span className="shrink-0 text-[12px] text-[#5f6368]">{smartDate(m.date)}</span>
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-lg border border-[#f1f3f4] px-5 py-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-medium text-white"
          style={{ backgroundColor: colorFor(m.fromAddr) }}
        >
          {m.fromInitial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[14px] font-medium text-[#202124]">{m.fromName}</span>
            <span className="truncate text-[12px] text-[#5f6368]">
              &lt;{m.fromAddr.replace(/^.*<|>.*$/g, "") || m.fromAddr}&gt;
            </span>
            <span className="ml-auto shrink-0 text-[12px] text-[#5f6368]">{fullDate(m.date)}</span>
          </div>
          <div className="text-[12px] text-[#5f6368]">to {m.to || "me"}</div>
        </div>
      </div>

      <div className="mt-4 pl-[52px]">
        <MessageBody m={m} />
      </div>
    </div>
  );
}

// HTML bodies ONLY in a sandboxed iframe (synced marketing email is hostile
// input; never inject into the app DOM).
function MessageBody({ m }: { m: ThreadMessageView }) {
  if (m.html) {
    return (
      <iframe
        sandbox=""
        srcDoc={`<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font-family:Roboto,Arial,sans-serif;color:#202124;margin:0;font-size:14px;line-height:1.5}img{max-width:100%}</style></head><body>${m.html}</body></html>`}
        className="min-h-[80px] w-full"
        style={{ border: "none", height: "auto" }}
        onLoad={(e) => {
          const f = e.currentTarget;
          try {
            const h = f.contentWindow?.document.body?.scrollHeight;
            if (h) f.style.height = `${h + 8}px`;
          } catch {
            /* cross-origin guard */
          }
        }}
      />
    );
  }
  return (
    <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-[#202124]">
      {m.text || m.snippet}
    </div>
  );
}
