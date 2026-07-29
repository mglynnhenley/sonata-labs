"use client";

import { useState } from "react";
import type { ActivityData, ActionRow } from "./types";
import { smartDate } from "./types";

const ACTION_ICON: Record<string, string> = {
  send: "send",
  modify: "label",
  trash: "delete",
  untrash: "restore_from_trash",
  delete: "delete_forever",
  batchModify: "label",
  batchDelete: "delete_sweep",
  labelCreate: "new_label",
  labelUpdate: "edit",
  labelDelete: "label_off",
  draftCreate: "draft",
  draftUpdate: "edit_note",
  draftSend: "send",
};

export function ActivityPanel({
  data,
  onReset,
}: {
  data: ActivityData | null;
  onReset: () => void;
}) {
  const [tab, setTab] = useState<"actions" | "outbox">("actions");

  return (
    <aside className="flex w-[340px] shrink-0 flex-col overflow-hidden border-l border-[#e0e3e7] bg-white">
      <div className="flex items-center gap-2 border-b border-[#e0e3e7] px-4 py-3">
        <span className="material-symbols-outlined text-[#1a73e8]">monitoring</span>
        <span className="text-sm font-medium text-[#202124]">Agent Activity</span>
        <button
          onClick={onReset}
          className="ml-auto flex items-center gap-1 rounded-full border border-[#dadce0] px-3 py-1 text-xs font-medium text-[#3c4043] hover:bg-[#f6fafe]"
          title="Reset the working mailbox to the pristine snapshot"
        >
          <span className="material-symbols-outlined text-[16px]">restart_alt</span>
          Reset
        </button>
      </div>

      <div className="flex border-b border-[#e0e3e7] text-sm">
        <TabButton active={tab === "actions"} onClick={() => setTab("actions")}>
          Actions {data ? `(${data.actions.length})` : ""}
        </TabButton>
        <TabButton active={tab === "outbox"} onClick={() => setTab("outbox")}>
          Outbox {data ? `(${data.outbox.length})` : ""}
        </TabButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto gm-scroll">
        {!data && <div className="p-4 text-xs text-[#5f6368]">Loading…</div>}
        {data && tab === "actions" && (
          <>
            {data.actions.length === 0 && (
              <div className="p-4 text-xs text-[#5f6368]">
                No actions yet. Mutations made through the Gmail API (or this UI) appear here live.
              </div>
            )}
            {data.actions.map((a) => (
              <ActionItem key={a.id} a={a} />
            ))}
          </>
        )}
        {data && tab === "outbox" && (
          <>
            {data.outbox.length === 0 && (
              <div className="p-4 text-xs text-[#5f6368]">
                Nothing sent yet. Simulated sends land here — nothing leaves the machine.
              </div>
            )}
            {data.outbox.map((o) => (
              <div key={o.id} className="border-b border-[#f1f3f4] px-4 py-3 text-xs">
                <div className="flex items-center gap-2 text-[#202124]">
                  <span className="material-symbols-outlined text-[16px] text-[#1a73e8]">outbox</span>
                  <span className="font-medium">{o.envelopeTo.join(", ") || "(no recipient)"}</span>
                </div>
                <div className="mt-1 text-[#5f6368]">
                  msg {o.messageId} · {smartDate(o.createdAt)}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {data && (
        <div className="border-t border-[#e0e3e7] px-4 py-2 text-[11px] text-[#5f6368]">
          {data.sessions.length} session{data.sessions.length === 1 ? "" : "s"} ·{" "}
          {data.sessions.reduce((n, s) => n + s.action_count, 0)} total actions logged
        </div>
      )}
    </aside>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-4 py-2 font-medium ${active ? "border-b-2 border-[#1a73e8] text-[#1a73e8]" : "text-[#5f6368] hover:bg-[#f6f8fc]"}`}
    >
      {children}
    </button>
  );
}

function ActionItem({ a }: { a: ActionRow }) {
  const [open, setOpen] = useState(false);
  const icon = ACTION_ICON[a.action_type || ""] || "bolt";
  return (
    <div className="border-b border-[#f1f3f4] px-4 py-2.5">
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined mt-0.5 text-[18px] text-[#5f6368]">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-[#202124]">{a.summary}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[#5f6368]">
            <span className="rounded bg-[#e8f0fe] px-1 font-medium text-[#1967d2]">{a.method}</span>
            <span className="truncate">{a.endpoint}</span>
            <span className="ml-auto shrink-0">{smartDate(a.ts)}</span>
          </div>
          {a.request_json && (
            <button
              onClick={() => setOpen((o) => !o)}
              className="mt-1 text-[11px] text-[#1a73e8] hover:underline"
            >
              {open ? "Hide" : "Show"} request
            </button>
          )}
          {open && a.request_json && (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-[#f6f8fc] p-2 text-[10px] text-[#3c4043] gm-scroll">
              {JSON.stringify(JSON.parse(a.request_json), null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
