"use client";

import type { ListView, ThreadRow } from "./types";
import { smartDate } from "./types";

export function MessageList({
  view,
  title,
  page,
  onOpen,
  onPrev,
  onNext,
  onRefresh,
}: {
  view: ListView | null;
  title: string;
  page: number;
  onOpen: (threadId: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onRefresh: () => void;
}) {
  const total = view?.total ?? 0;
  const pageSize = view?.pageSize ?? 50;
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex h-12 shrink-0 items-center gap-1 px-3 text-[#5f6368]">
        <span className="flex items-center rounded-sm p-2">
          <input type="checkbox" className="h-[18px] w-[18px] accent-[#1a73e8]" readOnly />
        </span>
        <button onClick={onRefresh} className="rounded-full p-2 hover:bg-[#e9eef6]" title="Refresh">
          <span className="material-symbols-outlined text-[20px]">refresh</span>
        </button>
        <button className="rounded-full p-2 hover:bg-[#e9eef6]" title="More">
          <span className="material-symbols-outlined text-[20px]">more_vert</span>
        </button>
        <div className="ml-auto flex items-center gap-1 text-[13px]">
          <span className="mr-1">
            {start}–{end} of <span className="font-medium">{total.toLocaleString()}</span>
          </span>
          <button
            onClick={onPrev}
            disabled={page === 0}
            className="rounded-full p-2 enabled:hover:bg-[#e9eef6] disabled:opacity-40"
          >
            <span className="material-symbols-outlined text-[20px]">chevron_left</span>
          </button>
          <button
            onClick={onNext}
            disabled={end >= total}
            className="rounded-full p-2 enabled:hover:bg-[#e9eef6] disabled:opacity-40"
          >
            <span className="material-symbols-outlined text-[20px]">chevron_right</span>
          </button>
        </div>
      </div>

      {/* Rows */}
      <div className="min-h-0 flex-1 overflow-y-auto gm-scroll">
        {view && view.rows.length === 0 && (
          <div className="flex h-40 items-center justify-center text-sm text-[#5f6368]">
            No conversations{title ? ` in ${title}` : ""}.
          </div>
        )}
        {view?.rows.map((r) => (
          <Row key={r.threadId} row={r} onOpen={() => onOpen(r.threadId)} />
        ))}
      </div>
    </div>
  );
}

function Row({ row, onOpen }: { row: ThreadRow; onOpen: () => void }) {
  const bg = row.unread ? "bg-white" : "bg-[#f2f6fc]";
  const weight = row.unread ? "font-bold text-[#202124]" : "font-normal text-[#5f6368]";
  return (
    <div
      onClick={onOpen}
      className={`group flex h-[40px] cursor-pointer items-center gap-3 border-b border-[#f1f3f4] pl-3 pr-4 ${bg} hover:z-10 hover:shadow-[inset_1px_0_0_#dadce0,inset_-1px_0_0_#dadce0,0_1px_2px_0_rgba(60,64,67,.3),0_1px_3px_1px_rgba(60,64,67,.15)]`}
    >
      <input
        type="checkbox"
        onClick={(e) => e.stopPropagation()}
        className="h-[18px] w-[18px] shrink-0 accent-[#1a73e8]"
        readOnly
      />
      <button onClick={(e) => e.stopPropagation()} className="shrink-0" title="Star">
        <span
          className={`material-symbols-outlined text-[20px] ${row.starred ? "filled text-[#f9ab00]" : "text-[#5f6368] opacity-0 group-hover:opacity-100"}`}
        >
          star
        </span>
      </button>
      <span
        className={`material-symbols-outlined shrink-0 text-[20px] ${row.important ? "filled text-[#f9ab00]" : "text-[#dadce0]"}`}
        title="Important"
      >
        label_important
      </span>

      <div className={`w-[168px] shrink-0 truncate text-[14px] ${weight}`}>
        {row.participants}
        {row.count > 1 && <span className="ml-1 font-normal text-[#5f6368]">{row.count}</span>}
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2 text-[14px]">
        {row.labels.map((l) => (
          <span
            key={l.name}
            className="shrink-0 rounded px-1.5 py-[1px] text-[11px] font-medium"
            style={{ color: l.textColor, backgroundColor: l.backgroundColor }}
          >
            {l.name}
          </span>
        ))}
        <span className={`shrink-0 ${weight}`}>{row.subject}</span>
        <span className="truncate font-normal text-[#5f6368]">
          {row.snippet ? `- ${row.snippet}` : ""}
        </span>
      </div>

      <div className="ml-2 flex shrink-0 items-center gap-1">
        {row.hasAttachment && (
          <span className="material-symbols-outlined text-[18px] text-[#5f6368]">attach_file</span>
        )}
        {/* Date, replaced by hover actions */}
        <span className={`w-[70px] text-right text-[12px] group-hover:hidden ${weight}`}>
          {smartDate(row.date)}
        </span>
        <div className="hidden items-center gap-1 group-hover:flex">
          {["archive", "delete", "mark_email_unread", "schedule"].map((ic) => (
            <button
              key={ic}
              onClick={(e) => e.stopPropagation()}
              className="rounded-full p-1.5 hover:bg-[#e9eef6]"
            >
              <span className="material-symbols-outlined text-[20px] text-[#5f6368]">{ic}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
