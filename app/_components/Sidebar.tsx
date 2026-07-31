"use client";

import { useState } from "react";
import type { SidebarData, UiChannelSummary } from "./types";

// Slack's workspace sidebar: aubergine #3f0e40, active row #1164a3, hover
// rgba(255,255,255,.1). Idle labels sit at 70% white; unread/active go full
// white and semibold.

function Avatar({ initials, color, size = 20 }: { initials: string; color: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[3px] font-bold text-white"
      style={{ background: color, width: size, height: size, fontSize: size * 0.42 }}
    >
      {initials}
    </span>
  );
}

function PresenceDot({ online }: { online: boolean }) {
  return online ? (
    <span className="inline-block size-[8px] shrink-0 rounded-full bg-[#2bac76]" />
  ) : (
    <span className="inline-block size-[8px] shrink-0 rounded-full border-[1.5px] border-white/60" />
  );
}

function SectionHeader({
  label,
  collapsed,
  onToggle,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="group flex w-full items-center gap-1 rounded-[4px] px-2 py-[3px] text-left text-[13px] text-white/70 hover:bg-white/10"
    >
      <svg
        viewBox="0 0 12 12"
        className="size-[12px] shrink-0 transition-transform duration-150"
        style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}
        aria-hidden
      >
        <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="truncate">{label}</span>
    </button>
  );
}

function Row({
  item,
  active,
  onSelect,
}: {
  item: UiChannelSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const isDm = item.kind === "im" || item.kind === "mpim";
  // Slack's rule: unread rows go full-white and bold; the active row wins over
  // unread styling because you're already looking at it.
  const unread = !active && item.unread > 0;
  return (
    <button
      onClick={onSelect}
      title={item.name}
      className={[
        "flex w-full items-center gap-2 rounded-[4px] px-2 py-[3px] text-left text-[15px] leading-[1.46] transition-colors",
        active
          ? "bg-[#1164a3] text-white"
          : unread
            ? "font-bold text-white hover:bg-white/10"
            : "text-white/70 hover:bg-white/10",
      ].join(" ")}
    >
      {item.kind === "channel" ? (
        <span className="w-[14px] shrink-0 text-center text-[16px] font-light opacity-90">#</span>
      ) : item.kind === "private" ? (
        <svg viewBox="0 0 16 16" className="size-[14px] shrink-0 opacity-90" aria-hidden>
          <path
            d="M11 7V5a3 3 0 10-6 0v2H4v7h8V7h-1zM6.2 5a1.8 1.8 0 113.6 0v2H6.2V5z"
            fill="currentColor"
          />
        </svg>
      ) : item.kind === "mpim" ? (
        <span className="w-[14px] shrink-0 text-center text-[11px] opacity-90">👥</span>
      ) : (
        <span className="flex w-[14px] shrink-0 justify-center">
          <PresenceDot online={!item.partner?.isBot} />
        </span>
      )}
      <span className={["truncate", active ? "font-semibold" : ""].join(" ")}>{item.name}</span>
      {item.isArchived && <span className="ml-auto text-[11px] opacity-60">archived</span>}
      {isDm && item.partner?.isBot && !item.badge && (
        <span className="ml-auto rounded-[2px] bg-white/20 px-1 text-[9px] font-bold uppercase tracking-wide">
          app
        </span>
      )}
      {item.badge > 0 && (
        <span className="ml-auto shrink-0 rounded-[9px] bg-[#cd2553] px-[6px] py-px text-[12px] font-bold tabular-nums text-white">
          {item.badge > 99 ? "99+" : item.badge}
        </span>
      )}
    </button>
  );
}

export function Sidebar({
  data,
  activeId,
  onSelect,
  onOpenActivity,
  activityActive,
}: {
  data: SidebarData;
  activeId: string | null;
  onSelect: (id: string) => void;
  onOpenActivity: () => void;
  activityActive: boolean;
}) {
  const [channelsOpen, setChannelsOpen] = useState(true);
  const [dmsOpen, setDmsOpen] = useState(true);

  return (
    <nav className="flex h-full w-[260px] shrink-0 flex-col bg-[#3f0e40] text-white">
      {/* Workspace header */}
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-[13px]">
        <button className="flex min-w-0 items-center gap-1 text-left">
          <h1 className="truncate text-[18px] font-black leading-tight tracking-[-0.01em]">
            {data.team.name}
          </h1>
          <svg viewBox="0 0 12 12" className="mt-[3px] size-[11px] shrink-0" aria-hidden>
            <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          title="New message"
          className="grid size-[26px] shrink-0 place-items-center rounded-full bg-white text-[#3f0e40] transition hover:opacity-90"
        >
          <svg viewBox="0 0 18 18" className="size-[14px]" aria-hidden>
            <path
              d="M12.7 1.6a1.7 1.7 0 012.4 2.4l-.9.9-2.4-2.4.9-.9zM10.5 3.8l2.4 2.4-7 7H3.5v-2.4l7-7z"
              fill="currentColor"
            />
          </svg>
        </button>
      </header>

      {/* Top rail */}
      <div className="space-y-px px-2 pt-2">
        {[
          { label: "Threads", icon: "💬" },
          { label: "Drafts & sent", icon: "📝" },
        ].map((x) => (
          <button
            key={x.label}
            className="flex w-full items-center gap-2 rounded-[4px] px-2 py-[3px] text-left text-[15px] text-white/70 hover:bg-white/10"
          >
            <span className="w-[14px] shrink-0 text-center text-[12px]">{x.icon}</span>
            <span className="truncate">{x.label}</span>
          </button>
        ))}
        <button
          onClick={onOpenActivity}
          className={[
            "flex w-full items-center gap-2 rounded-[4px] px-2 py-[3px] text-left text-[15px] transition-colors",
            activityActive ? "bg-[#1164a3] font-semibold text-white" : "text-white/70 hover:bg-white/10",
          ].join(" ")}
        >
          <span className="w-[14px] shrink-0 text-center text-[12px]">🛰️</span>
          <span className="truncate">Agent activity</span>
        </button>
      </div>

      <div className="mt-2 flex-1 overflow-y-auto px-2 pb-4 [scrollbar-color:rgba(255,255,255,.3)_transparent] [scrollbar-width:thin]">
        <SectionHeader
          label="Channels"
          collapsed={!channelsOpen}
          onToggle={() => setChannelsOpen((v) => !v)}
        />
        {channelsOpen && (
          <div className="space-y-px">
            {data.channels.map((c) => (
              <Row key={c.id} item={c} active={c.id === activeId} onSelect={() => onSelect(c.id)} />
            ))}
          </div>
        )}

        <div className="mt-3">
          <SectionHeader
            label="Direct messages"
            collapsed={!dmsOpen}
            onToggle={() => setDmsOpen((v) => !v)}
          />
          {dmsOpen && (
            <div className="space-y-px">
              {data.dms.map((c) => (
                <Row key={c.id} item={c} active={c.id === activeId} onSelect={() => onSelect(c.id)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Self footer */}
      <footer className="flex items-center gap-2 border-t border-white/10 px-3 py-2">
        <Avatar initials={data.self.initials} color={data.self.color} size={26} />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-tight">{data.self.realName}</div>
          <div className="truncate text-[11px] leading-tight text-white/60">active</div>
        </div>
      </footer>
    </nav>
  );
}
