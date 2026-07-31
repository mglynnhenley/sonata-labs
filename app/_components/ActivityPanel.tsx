"use client";

import { useState } from "react";
import { ChaosPanel } from "./ChaosPanel";
import { EventsPanel } from "./EventsPanel";
import type { ActivityData } from "./types";

// The observability surface: what the agent-under-test actually did. Sessions,
// a live action feed with expandable request JSON, the outbox ledger, and the
// reset button.

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

const ACTION_TINT: Record<string, string> = {
  post: "bg-[#007a5a]",
  update: "bg-[#1264a3]",
  delete: "bg-[#e01e5a]",
  react: "bg-[#ecb22e]",
  unreact: "bg-[#c9a227]",
  pin: "bg-[#ecb22e]",
  unpin: "bg-[#c9a227]",
  create_channel: "bg-[#4a154b]",
  invite: "bg-[#4a154b]",
  upload: "bg-[#36c5f0]",
  schedule: "bg-[#616061]",
};

function ActionRowView({ a }: { a: ActivityData["actions"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-[#f0f0f0] last:border-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-4 py-2 text-left hover:bg-[#f8f8f8]"
      >
        <span
          className={[
            "mt-[5px] size-[8px] shrink-0 rounded-full",
            ACTION_TINT[a.action_type ?? ""] ?? "bg-[#9b9b9b]",
          ].join(" ")}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] leading-[1.4] text-[#1d1c1d]">{a.summary}</span>
          <span className="mt-[1px] flex items-center gap-2 text-[11px] text-[#616061]">
            <code className="font-mono">{a.endpoint}</code>
            <span>{timeLabel(a.ts)}</span>
            {a.target_id && <code className="truncate font-mono opacity-70">{a.target_id}</code>}
          </span>
        </span>
        <span className="mt-[1px] shrink-0 text-[13px] leading-none text-[#616061]">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <pre className="mx-4 mb-2 max-h-[220px] overflow-auto rounded-[4px] border border-[#e8e8e8] bg-[#f8f8f8] p-2 font-mono text-[11px] leading-[1.5] text-[#1d1c1d]">
          {JSON.stringify(a.request ?? {}, null, 2)}
        </pre>
      )}
    </li>
  );
}

export function ActivityPanel({
  data,
  onSelectSession,
  onReset,
  resetting,
}: {
  data: ActivityData;
  onSelectSession: (id: string) => void;
  onReset: () => void;
  resetting: boolean;
}) {
  const [tab, setTab] = useState<"feed" | "outbox">("feed");
  const scheduled = data.outbox.filter((o) => o.post_at != null);

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-white">
      <header className="border-b border-[#e8e8e8] px-5 py-[10px]">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[18px] font-black leading-tight text-[#1d1c1d]">Agent activity</h2>
            <p className="text-[12px] text-[#616061]">
              Every sandbox mutation, logged atomically with the change itself.
            </p>
          </div>
          <button
            onClick={onReset}
            disabled={resetting}
            className="rounded-[4px] bg-[#e01e5a] px-3 py-[6px] text-[13px] font-bold text-white transition hover:bg-[#c4184c] disabled:opacity-60"
          >
            {resetting ? "Resetting…" : "Reset to snapshot"}
          </button>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <label className="flex items-center gap-2 text-[13px] text-[#616061]">
            Session
            <select
              value={data.session_id}
              onChange={(e) => onSelectSession(e.target.value)}
              className="max-w-[280px] rounded-[4px] border border-[#c9c9c9] bg-white px-2 py-[3px] text-[13px] text-[#1d1c1d]"
            >
              {data.sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {new Date(s.started_at).toLocaleString("en-US", { hour12: false })} —{" "}
                  {s.note ?? "session"} ({s.action_count})
                </option>
              ))}
            </select>
          </label>
          <nav className="ml-auto flex gap-1">
            {(["feed", "outbox"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={[
                  "rounded-[4px] px-3 py-[4px] text-[13px] font-semibold capitalize transition",
                  tab === t ? "bg-[#f0f0f0] text-[#1d1c1d]" : "text-[#616061] hover:bg-[#f8f8f8]",
                ].join(" ")}
              >
                {t === "feed" ? `Feed (${data.actions.length})` : `Outbox (${data.outbox.length})`}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {tab === "feed" ? (
          data.actions.length === 0 ? (
            <p className="px-5 py-8 text-[14px] text-[#616061]">
              No actions in this session yet. Point an agent at{" "}
              <code className="rounded bg-[#f6f6f6] px-1 font-mono text-[12px]">/api/</code> and
              watch them appear.
            </p>
          ) : (
            <ul>
              {[...data.actions].reverse().map((a) => (
                <ActionRowView key={a.id} a={a} />
              ))}
            </ul>
          )
        ) : (
          <div className="p-4">
            <p className="mb-3 text-[13px] text-[#616061]">
              Nothing here left the machine. {data.outbox.length} sent,{" "}
              {scheduled.length} scheduled.
            </p>
            <ul className="space-y-2">
              {[...data.outbox].map((o) => (
                <li
                  key={o.id}
                  className="rounded-[6px] border border-[#e8e8e8] p-3 text-[13px] text-[#1d1c1d]"
                >
                  <div className="flex items-center justify-between">
                    <code className="font-mono text-[12px] text-[#616061]">
                      {o.channel_id} · {o.message_ts}
                    </code>
                    {o.post_at != null && (
                      <span className="rounded-[3px] bg-[#fff8e1] px-[5px] text-[11px] font-semibold text-[#946f00]">
                        scheduled {new Date(o.post_at * 1000).toLocaleString("en-US", { hour12: false })}
                      </span>
                    )}
                  </div>
                  <pre className="mt-2 max-h-[140px] overflow-auto rounded-[4px] bg-[#f8f8f8] p-2 font-mono text-[11px] leading-[1.5]">
                    {JSON.stringify(o.request ?? {}, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="max-h-[45%] shrink-0 overflow-y-auto">
        <EventsPanel />
        <ChaosPanel />
      </div>
    </section>
  );
}
