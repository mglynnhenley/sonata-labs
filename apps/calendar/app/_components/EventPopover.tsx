"use client";

import { useEffect, useRef, useState } from "react";
import type { GridEvent } from "./types";
import { wallParts, monthName, clockLabel } from "./time";

const RESPONSE_META: Record<string, { icon: string; color: string; label: string }> = {
  accepted: { icon: "check_circle", color: "#188038", label: "Yes" },
  declined: { icon: "cancel", color: "#d93025", label: "No" },
  tentative: { icon: "help", color: "#f29900", label: "Maybe" },
  needsAction: { icon: "radio_button_unchecked", color: "#80868b", label: "Awaiting" },
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dateLine(ev: GridEvent, timeZone: string): string {
  const p = wallParts(ev.startMs, timeZone);
  const day = `${WEEKDAYS[p.weekday]}, ${monthName(p.month)} ${p.day}`;
  if (ev.allDay) return day;
  return `${day} · ${clockLabel(ev.startMs, timeZone)} – ${clockLabel(ev.endMs, timeZone)}`;
}

export function EventPopover({
  event,
  anchor,
  timeZone,
  calendarName,
  color,
  onClose,
}: {
  event: GridEvent;
  anchor: DOMRect;
  timeZone: string;
  calendarName: string;
  color: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Google anchors the card beside the block; clamp so it never leaves the
  // viewport. Position is computed after mount, once the card's size is known.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    const { width, height } = card.getBoundingClientRect();
    const pad = 8;
    let left = anchor.right + pad;
    if (left + width > window.innerWidth - pad) left = anchor.left - width - pad;
    if (left < pad) left = pad;
    let top = anchor.top;
    if (top + height > window.innerHeight - pad) top = window.innerHeight - height - pad;
    if (top < pad) top = pad;
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const accepted = event.attendees.filter((a) => a.responseStatus === "accepted").length;

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        className="fixed z-50 w-[400px] rounded-lg bg-white pb-4 shadow-[0_4px_16px_rgba(60,64,67,0.35)]"
        style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
      >
        <div className="flex items-center justify-end gap-1 px-2 pt-2">
          <button onClick={onClose} className="rounded-full p-2 hover:bg-gc-hover" aria-label="Close">
            <span className="material-symbols-outlined text-[20px] text-gc-muted">close</span>
          </button>
        </div>

        <div className="flex gap-4 px-5">
          <span className="mt-1.5 h-4 w-4 shrink-0 rounded" style={{ backgroundColor: color }} />
          <div className="min-w-0">
            <div
              className="text-[22px] leading-7 text-[#3c4043]"
              style={{ textDecoration: event.declinedByOwner ? "line-through" : undefined }}
            >
              {event.summary}
            </div>
            <div className="mt-1 text-sm text-gc-muted" title={`Times shown in ${timeZone}`}>
              {dateLine(event, timeZone)}
              {event.recurring ? " · Recurring" : ""}
            </div>
            {event.status !== "confirmed" && (
              <div className="mt-1 text-xs capitalize text-[#f29900]">{event.status}</div>
            )}
          </div>
        </div>

        {event.location && (
          <Row icon="location_on">
            <span className="text-sm text-[#3c4043]">{event.location}</span>
          </Row>
        )}

        {event.description && (
          <Row icon="notes">
            <div className="whitespace-pre-wrap text-sm text-[#3c4043]">{event.description}</div>
          </Row>
        )}

        {event.attendees.length > 0 && (
          <Row icon="group">
            <div className="text-sm text-[#3c4043]">
              {event.attendees.length} guest{event.attendees.length === 1 ? "" : "s"}
              <span className="ml-1 text-xs text-gc-muted">
                {accepted} yes
              </span>
            </div>
            <div className="mt-2 flex flex-col gap-2">
              {event.attendees.map((a) => {
                const meta = RESPONSE_META[a.responseStatus] ?? RESPONSE_META.needsAction!;
                const name = a.displayName || a.email;
                return (
                  <div key={a.email} className="flex items-center gap-2">
                    <div className="relative">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#7b1fa2] text-xs font-medium text-white">
                        {name[0]?.toUpperCase() ?? "?"}
                      </span>
                      <span
                        className="material-symbols-outlined filled absolute -bottom-1 -right-1 rounded-full bg-white text-[13px]"
                        style={{ color: meta.color }}
                        title={meta.label}
                      >
                        {meta.icon}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm text-[#3c4043]">
                        {name}
                        {a.email === event.organizer && (
                          <span className="ml-1 text-xs text-gc-muted">· Organizer</span>
                        )}
                      </div>
                      {a.displayName && (
                        <div className="truncate text-xs text-gc-muted">{a.email}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Row>
        )}

        <Row icon="calendar_today">
          <span className="text-sm text-[#3c4043]">{calendarName}</span>
        </Row>
      </div>
    </div>
  );
}

function Row({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 flex gap-4 px-5">
      <span className="material-symbols-outlined w-4 shrink-0 text-[20px] text-gc-muted">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
