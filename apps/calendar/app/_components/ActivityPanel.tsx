"use client";

import { useState } from "react";
import type { ActivityData, ActionRow } from "./types";
import { smartDate } from "./types";

// Calendar mutations logged by /calendar/v3 routes (see logAction call sites).
const ACTION_ICON: Record<string, string> = {
  eventInsert: "event",
  eventUpdate: "edit_calendar",
  eventPatch: "edit_calendar",
  eventDelete: "event_busy",
};

/**
 * Same panel the Gmail twin puts beside the inbox: the audit trail, polled
 * live, so a human can watch an agent rearrange the week. Read-only on purpose
 * — reset is token-gated (/api/sandbox/reset), a lever the watcher doesn't get.
 */
export function ActivityPanel({ data }: { data: ActivityData | null }) {
  return (
    <aside className="flex w-[340px] shrink-0 flex-col overflow-hidden border-l border-gc-border bg-white">
      <div className="flex items-center gap-2 border-b border-gc-border px-4 py-3">
        <span className="material-symbols-outlined text-[#1a73e8]">monitoring</span>
        <span className="text-sm font-medium text-[#202124]">Agent Activity</span>
        <span className="ml-auto text-xs text-gc-muted">
          {data ? `${data.actions.length} action${data.actions.length === 1 ? "" : "s"}` : ""}
        </span>
      </div>

      <div className="gc-scroll min-h-0 flex-1 overflow-y-auto">
        {!data && <div className="p-4 text-xs text-gc-muted">Loading…</div>}
        {data && data.actions.length === 0 && (
          <div className="p-4 text-xs text-gc-muted">
            No actions yet. Mutations made through the Calendar API appear here live.
          </div>
        )}
        {data?.actions.map((a) => <ActionItem key={a.id} a={a} />)}
      </div>

      {data && (
        <div className="border-t border-gc-border px-4 py-2 text-[11px] text-gc-muted">
          {data.sessions.length} session{data.sessions.length === 1 ? "" : "s"} ·{" "}
          {data.sessions.reduce((n, s) => n + s.action_count, 0)} total actions logged
        </div>
      )}
    </aside>
  );
}

function ActionItem({ a }: { a: ActionRow }) {
  const [open, setOpen] = useState(false);
  const icon = ACTION_ICON[a.action_type || ""] || "bolt";
  return (
    <div className="border-b border-[#f1f3f4] px-4 py-2.5">
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined mt-0.5 text-[18px] text-gc-muted">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-[#202124]">{a.summary}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-gc-muted">
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
            <pre className="gc-scroll mt-1 max-h-40 overflow-auto rounded bg-[#f8fafd] p-2 text-[10px] text-[#3c4043]">
              {JSON.stringify(JSON.parse(a.request_json), null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
