"use client";

import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { ChannelPane } from "./ChannelPane";
import { ThreadPane } from "./ThreadPane";
import { ActivityPanel } from "./ActivityPanel";
import { SearchResults } from "./SearchResults";
import type { ActivityData, ChannelData, SearchData, SidebarData, ThreadData } from "./types";

const POLL_MS = 3000;
const TOKEN = "sandbox-token";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Call the sandbox's own Slack-compatible API, exactly as an agent would. */
async function callApi(method: string, args: Record<string, string>): Promise<void> {
  await fetch(`/api/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Bearer ${TOKEN}`,
    },
    body: new URLSearchParams(args).toString(),
  });
}

type View = { kind: "channel"; id: string } | { kind: "activity" } | { kind: "search"; q: string };

export function SlackApp() {
  const [sidebar, setSidebar] = useState<SidebarData | null>(null);
  const [view, setView] = useState<View>({ kind: "activity" });
  const [channel, setChannel] = useState<ChannelData | null>(null);
  const [thread, setThread] = useState<{ id: string; ts: string } | null>(null);
  const [threadData, setThreadData] = useState<ThreadData | null>(null);
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const [activitySession, setActivitySession] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchData | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Initial sidebar load picks a sensible default channel.
  useEffect(() => {
    void (async () => {
      const s = await getJson<SidebarData>("/api/ui/sidebar");
      if (!s) return;
      setSidebar(s);
      const general = s.channels.find((c) => c.isGeneral) ?? s.channels[0];
      if (general) openChannel(general.id);
    })();
  }, []);

  const refresh = useCallback(async () => {
    const tasks: Array<Promise<void>> = [
      getJson<SidebarData>("/api/ui/sidebar").then((s) => {
        if (s) setSidebar(s);
      }),
    ];
    if (view.kind === "channel") {
      // Background polls must NOT mark read — otherwise a channel you're not
      // looking at silently loses its badge. Only openChannel marks read.
      tasks.push(
        getJson<ChannelData>(`/api/ui/channel/${view.id}`).then((c) => setChannel(c)),
      );
    }
    if (view.kind === "activity") {
      const qs = activitySession ? `?session=${activitySession}` : "";
      tasks.push(getJson<ActivityData>(`/api/activity${qs}`).then((a) => setActivity(a)));
    }
    if (thread) {
      tasks.push(
        getJson<ThreadData>(`/api/ui/thread/${thread.id}/${thread.ts}`).then((t) => {
          setThreadData(t);
          if (!t) setThread(null);
        }),
      );
    }
    await Promise.all(tasks);
  }, [view, thread, activitySession]);

  // Poll so agent writes appear live.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const runSearch = async (q: string) => {
    setView({ kind: "search", q });
    setSearch(await getJson<SearchData>(`/api/ui/search?q=${encodeURIComponent(q)}`));
  };

  const openChannel = (id: string) => {
    setView({ kind: "channel", id });
    setThread(null);
    setChannel(null);
    // read=1 clears the badge — this is the deliberate "I opened it" signal.
    void getJson<ChannelData>(`/api/ui/channel/${id}?read=1`).then((c) => {
      setChannel(c);
      void refresh();
    });
  };

  const toggleReaction = async (channelId: string, ts: string, name: string, reacted: boolean) => {
    setBusy(true);
    await callApi(reacted ? "reactions.remove" : "reactions.add", {
      channel: channelId,
      timestamp: ts,
      name,
    });
    await refresh();
    setBusy(false);
  };

  const send = async (channelId: string, text: string, threadTs?: string) => {
    setBusy(true);
    await callApi("chat.postMessage", {
      channel: channelId,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    await refresh();
    setBusy(false);
  };

  const doReset = async () => {
    setResetting(true);
    await fetch("/api/sandbox/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "reset from activity panel" }),
    });
    setActivitySession(null);
    setThread(null);
    await refresh();
    setResetting(false);
  };

  if (!sidebar) {
    return (
      <div className="grid h-dvh place-items-center bg-[#f8f8f8] text-[14px] text-[#616061]">
        Loading workspace…
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#3f0e40]">
      {/* Top bar */}
      <header className="flex shrink-0 items-center gap-3 px-3 py-[7px]">
        <div className="w-[240px] shrink-0" />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) void runSearch(query.trim());
          }}
          className="flex max-w-[720px] flex-1 items-center"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${sidebar.team.name}`}
            className="w-full rounded-[6px] border border-white/25 bg-white/10 px-3 py-[5px] text-[14px] text-white outline-none transition placeholder:text-white/60 focus:border-white/50 focus:bg-white/15"
          />
        </form>
        <div className="w-[120px] shrink-0" />
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-tl-[8px] rounded-tr-[8px] bg-white">
        <Sidebar
          data={sidebar}
          activeId={view.kind === "channel" ? view.id : null}
          onSelect={openChannel}
          onOpenActivity={() => {
            setView({ kind: "activity" });
            setThread(null);
          }}
          activityActive={view.kind === "activity"}
        />

        {view.kind === "channel" &&
          (channel ? (
            <ChannelPane
              data={channel}
              directories={sidebar.directories}
              onOpenThread={(ts) => setThread({ id: channel.channel.id, ts })}
              onToggleReaction={(ts, name, reacted) =>
                void toggleReaction(channel.channel.id, ts, name, reacted)
              }
              onSend={(text) => void send(channel.channel.id, text)}
              sending={busy}
            />
          ) : (
            <div className="grid flex-1 place-items-center text-[14px] text-[#616061]">
              Loading channel…
            </div>
          ))}

        {view.kind === "activity" &&
          (activity ? (
            <ActivityPanel
              data={activity}
              onSelectSession={(id) => setActivitySession(id)}
              onReset={() => void doReset()}
              resetting={resetting}
            />
          ) : (
            <div className="grid flex-1 place-items-center text-[14px] text-[#616061]">
              Loading activity…
            </div>
          ))}

        {view.kind === "search" && (
          <SearchResults
            data={search}
            directories={sidebar.directories}
            onOpenChannel={openChannel}
          />
        )}

        {thread && threadData && (
          <ThreadPane
            data={threadData}
            directories={sidebar.directories}
            onClose={() => setThread(null)}
            onToggleReaction={(ts, name, reacted) =>
              void toggleReaction(thread.id, ts, name, reacted)
            }
            onReply={(text) => void send(thread.id, text, thread.ts)}
            sending={busy}
          />
        )}
      </div>
    </div>
  );
}
