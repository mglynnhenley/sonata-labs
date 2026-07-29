"use client";

import { useCallback, useEffect, useState } from "react";
import type { RailLabel, ListView, ThreadView, ActivityData } from "./types";
import { MessageList } from "./MessageList";
import { ThreadPane } from "./ThreadView";
import { ActivityPanel } from "./ActivityPanel";

type View = { kind: "list"; labelId: string; labelName: string } | { kind: "thread"; threadId: string };

const DEFAULT_VIEW: View = { kind: "list", labelId: "INBOX", labelName: "Inbox" };

// Left-rail nav order mirrors Gmail. System labels shown as friendly names.
const NAV: Array<{ id: string; name: string; icon: string }> = [
  { id: "INBOX", name: "Inbox", icon: "inbox" },
  { id: "STARRED", name: "Starred", icon: "star" },
  { id: "IMPORTANT", name: "Important", icon: "label_important" },
  { id: "SENT", name: "Sent", icon: "send" },
  { id: "DRAFT", name: "Drafts", icon: "draft" },
  { id: "SPAM", name: "Spam", icon: "report" },
  { id: "TRASH", name: "Trash", icon: "delete" },
];

export function GmailApp() {
  const [labels, setLabels] = useState<RailLabel[]>([]);
  const [email, setEmail] = useState("");
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [list, setList] = useState<ListView | null>(null);
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const [showActivity, setShowActivity] = useState(true);
  const [page, setPage] = useState(0);

  const refreshLabels = useCallback(async () => {
    const r = await fetch("/api/ui/labels").then((r) => r.json());
    setLabels(r.labels);
    setEmail(r.email);
  }, []);

  const refreshList = useCallback(async () => {
    if (view.kind !== "list") return;
    const params = new URLSearchParams({ page: String(page) });
    if (query) params.set("q", query);
    else params.set("label", view.labelId);
    const r = await fetch(`/api/ui/list?${params}`).then((r) => r.json());
    setList(r);
  }, [view, page, query]);

  const openThread = useCallback(async (threadId: string) => {
    const r = await fetch(`/api/ui/thread/${threadId}?markRead=1`).then((r) => r.json());
    setThread(r);
    setView({ kind: "thread", threadId });
    refreshLabels();
  }, [refreshLabels]);

  const refreshActivity = useCallback(async () => {
    const r = await fetch("/api/activity").then((r) => r.json());
    setActivity(r);
  }, []);

  // Initial + polling every 3s so agent writes appear live.
  useEffect(() => {
    refreshLabels();
    refreshActivity();
  }, [refreshLabels, refreshActivity]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  useEffect(() => {
    const t = setInterval(() => {
      refreshLabels();
      refreshActivity();
      if (view.kind === "list") refreshList();
      else if (view.kind === "thread") {
        fetch(`/api/ui/thread/${view.threadId}`).then((r) => r.json()).then(setThread).catch(() => {});
      }
    }, 3000);
    return () => clearInterval(t);
  }, [refreshLabels, refreshActivity, refreshList, view]);

  const selectLabel = (id: string, name: string) => {
    setQuery("");
    setSearchInput("");
    setPage(0);
    setView({ kind: "list", labelId: id, labelName: name });
  };

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(0);
    setQuery(searchInput);
    setView({ kind: "list", labelId: "", labelName: `Search results` });
  };

  const userLabels = labels.filter((l) => l.type === "user");
  const unreadFor = (id: string) => labels.find((l) => l.id === id)?.unread ?? 0;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#f6f8fc] text-[#1f1f1f]">
      {/* Top bar */}
      <header className="flex h-16 shrink-0 items-center gap-2 px-4">
        <div className="flex w-[209px] items-center gap-1">
          <button className="rounded-full p-3 hover:bg-[#e9eef6]" aria-label="Main menu">
            <span className="material-symbols-outlined text-[#5f6368]">menu</span>
          </button>
          <div className="flex select-none items-center gap-1 pl-1">
            <span className="material-symbols-outlined filled text-[28px] text-[#ea4335]">mail</span>
            <span className="text-[22px] font-medium tracking-tight text-[#5f6368]">Gmail</span>
            <span className="ml-1 rounded bg-[#e8eaed] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#5f6368]">
              sandbox
            </span>
          </div>
        </div>

        <form onSubmit={submitSearch} className="mx-2 flex max-w-[720px] flex-1 items-center">
          <div className="flex w-full items-center gap-3 rounded-lg bg-[#eaf1fb] px-4 py-2.5 focus-within:bg-white focus-within:shadow-[0_1px_3px_rgba(0,0,0,0.2)]">
            <span className="material-symbols-outlined text-[#5f6368]">search</span>
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search mail"
              className="w-full bg-transparent text-[16px] text-[#1f1f1f] outline-none placeholder:text-[#5f6368]"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => { setSearchInput(""); setQuery(""); setView(DEFAULT_VIEW); }}
                className="rounded-full p-1 hover:bg-[#e9eef6]"
              >
                <span className="material-symbols-outlined text-[#5f6368]">close</span>
              </button>
            )}
          </div>
        </form>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowActivity((s) => !s)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium ${showActivity ? "bg-[#d3e3fd] text-[#041e49]" : "text-[#5f6368] hover:bg-[#e9eef6]"}`}
            title="Agent activity panel"
          >
            <span className="material-symbols-outlined text-[20px]">monitoring</span>
            Activity
          </button>
          <button className="rounded-full p-2.5 hover:bg-[#e9eef6]" aria-label="Support">
            <span className="material-symbols-outlined text-[#5f6368]">help</span>
          </button>
          <button className="rounded-full p-2.5 hover:bg-[#e9eef6]" aria-label="Settings">
            <span className="material-symbols-outlined text-[#5f6368]">settings</span>
          </button>
          <button className="rounded-full p-2.5 hover:bg-[#e9eef6]" aria-label="Google apps">
            <span className="material-symbols-outlined text-[#5f6368]">apps</span>
          </button>
          <div
            className="ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-[#7b1fa2] text-sm font-medium text-white"
            title={email}
          >
            {(email[0] || "S").toUpperCase()}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left rail */}
        <nav className="w-[256px] shrink-0 overflow-y-auto gm-scroll pb-4 pr-2 pt-2">
          <button className="mb-4 ml-2 flex items-center gap-4 rounded-2xl bg-[#c2e7ff] py-4 pl-4 pr-6 shadow-sm hover:shadow-md">
            <span className="material-symbols-outlined text-[#001d35]">edit</span>
            <span className="text-sm font-medium text-[#001d35]">Compose</span>
          </button>

          {NAV.map((n) => {
            const active = view.kind === "list" && !query && view.labelId === n.id;
            const unread = unreadFor(n.id);
            return (
              <RailItem
                key={n.id}
                icon={n.icon}
                name={n.name}
                active={active}
                badge={n.id === "INBOX" || n.id === "SPAM" ? unread : 0}
                onClick={() => selectLabel(n.id, n.name)}
              />
            );
          })}

          {userLabels.length > 0 && (
            <div className="mt-3 border-t border-[#e0e3e7] pt-3">
              <div className="px-6 pb-1 text-xs font-medium text-[#5f6368]">Labels</div>
              {userLabels.map((l) => {
                const active = view.kind === "list" && !query && view.labelId === l.id;
                return (
                  <RailItem
                    key={l.id}
                    icon="label"
                    iconColor={l.color?.backgroundColor}
                    name={l.name}
                    active={active}
                    badge={l.unread}
                    onClick={() => selectLabel(l.id, l.name)}
                  />
                );
              })}
            </div>
          )}
        </nav>

        {/* Main content */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col pb-3 pr-3">
          <div className="flex min-h-0 flex-1 overflow-hidden rounded-2xl bg-white shadow-sm">
            <div className="flex min-h-0 flex-1 flex-col">
              {view.kind === "list" ? (
                <MessageList
                  view={list}
                  title={query ? `Search: ${query}` : view.labelName}
                  page={page}
                  onOpen={openThread}
                  onPrev={() => setPage((p) => Math.max(0, p - 1))}
                  onNext={() => setPage((p) => p + 1)}
                  onRefresh={refreshList}
                />
              ) : (
                <ThreadPane
                  thread={thread}
                  onBack={() => { setView(DEFAULT_VIEW); setThread(null); refreshList(); }}
                />
              )}
            </div>
          </div>
        </main>

        {showActivity && (
          <ActivityPanel data={activity} onReset={async () => {
            await fetch("/api/sandbox/reset", { method: "POST" });
            refreshLabels(); refreshActivity(); refreshList();
          }} />
        )}
      </div>
    </div>
  );
}

function RailItem({
  icon,
  name,
  active,
  badge,
  iconColor,
  onClick,
}: {
  icon: string;
  name: string;
  active: boolean;
  badge?: number;
  iconColor?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex h-9 w-full items-center gap-4 rounded-r-full pl-6 pr-3 text-sm ${
        active ? "bg-[#d3e3fd] font-bold text-[#041e49]" : "text-[#1f1f1f] hover:bg-[#eaeced]"
      }`}
    >
      {iconColor ? (
        <span
          className="material-symbols-outlined text-[20px]"
          style={{ color: iconColor }}
        >
          {icon}
        </span>
      ) : (
        <span className={`material-symbols-outlined text-[20px] ${active ? "filled text-[#041e49]" : "text-[#444746]"}`}>
          {icon}
        </span>
      )}
      <span className="flex-1 text-left">{name}</span>
      {badge ? <span className="text-xs font-bold">{badge}</span> : null}
    </button>
  );
}
