"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { WeekView, ActivityData, AnchorData } from "./types";
import { calendarColor } from "./types";
import { weekDays, weekTitle } from "./time";
import { WeekGrid, type EventClick } from "./WeekGrid";
import { EventPopover } from "./EventPopover";
import { ActivityPanel } from "./ActivityPanel";

const DAY_MS = 86_400_000;

export function CalendarApp() {
  // `anchorMs` is any instant inside the displayed week. It starts null and is
  // seeded from /api/ui/anchor — the week containing the most recent event —
  // because the sim runs on backdated/future dates, so anchoring on wall-clock
  // "now" would open most demos on an empty grid.
  const [anchorMs, setAnchorMs] = useState<number | null>(null);
  const [timeZone, setTimeZone] = useState("UTC");
  const [view, setView] = useState<WeekView | null>(null);
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const [showActivity, setShowActivity] = useState(true);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<EventClick | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    fetch("/api/ui/anchor")
      .then((r) => r.json())
      .then((a: AnchorData) => {
        setTimeZone(a.timeZone);
        setAnchorMs(a.anchorMs ?? Date.now());
      })
      .catch(() => setAnchorMs(Date.now()));
  }, []);

  const days = useMemo(
    () => (anchorMs === null ? null : weekDays(anchorMs, timeZone)),
    [anchorMs, timeZone],
  );

  const refreshWeek = useCallback(async () => {
    if (!days) return;
    const start = days[0]!.startMs;
    const end = days[6]!.startMs + DAY_MS;
    const r = (await fetch(`/api/ui/events?start=${start}&end=${end}`).then((r) =>
      r.json(),
    )) as WeekView;
    setView(r);
    // The stored zone can differ from the anchor default once data loads.
    if (r.timeZone) setTimeZone(r.timeZone);
  }, [days]);

  const refreshActivity = useCallback(async () => {
    const r = (await fetch("/api/activity?limit=100").then((r) => r.json())) as ActivityData;
    setActivity(r);
  }, []);

  useEffect(() => {
    refreshWeek();
    refreshActivity();
  }, [refreshWeek, refreshActivity]);

  // Same 3s cadence as the Gmail twin, so agent writes appear live.
  useEffect(() => {
    const t = setInterval(() => {
      refreshWeek();
      refreshActivity();
      setNowMs(Date.now());
    }, 3000);
    return () => clearInterval(t);
  }, [refreshWeek, refreshActivity]);

  // Mid-week + noon-ish jumps stay DST-safe: weekDays() renormalizes.
  const shiftWeek = (weeks: number) => {
    if (!days) return;
    setAnchorMs(days[3]!.startMs + DAY_MS / 2 + weeks * 7 * DAY_MS);
    setSelected(null);
  };

  const calendars = view?.calendars ?? [];
  const visibleEvents = (view?.events ?? []).filter((e) => !hidden.has(e.calendarId));
  const colorFor = useCallback(
    (calendarId: string) => calendarColor(calendars, calendarId),
    [calendars],
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-gc-page text-gc-text">
      {/* Top bar */}
      <header className="flex h-16 shrink-0 items-center gap-2 border-b border-gc-border px-4">
        <div className="flex items-center gap-1">
          <button className="rounded-full p-3 hover:bg-gc-hover" aria-label="Main menu">
            <span className="material-symbols-outlined text-gc-muted">menu</span>
          </button>
          <div className="flex select-none items-center gap-2 pl-1">
            <span className="material-symbols-outlined filled text-[28px] text-[#1a73e8]">
              calendar_month
            </span>
            <span className="text-[22px] font-normal tracking-tight text-gc-muted">Calendar</span>
            <span className="rounded bg-[#e8eaed] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gc-muted">
              sandbox
            </span>
          </div>
        </div>

        <button
          onClick={() => {
            setAnchorMs(Date.now());
            setSelected(null);
          }}
          className="ml-6 rounded border border-[#dadce0] px-4 py-1.5 text-sm font-medium text-[#3c4043] hover:bg-gc-hover"
          title="Jump to the wall-clock week (the sim may live elsewhere)"
        >
          Today
        </button>
        <button onClick={() => shiftWeek(-1)} className="rounded-full p-2 hover:bg-gc-hover" aria-label="Previous week">
          <span className="material-symbols-outlined text-gc-muted">chevron_left</span>
        </button>
        <button onClick={() => shiftWeek(1)} className="rounded-full p-2 hover:bg-gc-hover" aria-label="Next week">
          <span className="material-symbols-outlined text-gc-muted">chevron_right</span>
        </button>
        <h1
          className="ml-2 text-[22px] font-normal text-[#3c4043]"
          title={`All times shown in ${timeZone} — the calendar's stored time zone`}
        >
          {days ? weekTitle(days) : ""}
        </h1>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setShowActivity((s) => !s)}
            title="Live agent action feed"
            className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium ${
              showActivity ? "bg-gc-active text-[#041e49]" : "text-gc-muted hover:bg-gc-hover"
            }`}
          >
            <span className="material-symbols-outlined text-[20px]">monitoring</span>
            Activity
          </button>
          <button className="rounded-full p-2.5 hover:bg-gc-hover" aria-label="Support">
            <span className="material-symbols-outlined text-gc-muted">help</span>
          </button>
          <button className="rounded-full p-2.5 hover:bg-gc-hover" aria-label="Settings">
            <span className="material-symbols-outlined text-gc-muted">settings</span>
          </button>
          <div
            className="ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-[#7b1fa2] text-sm font-medium text-white"
            title={view?.ownerEmail ?? ""}
          >
            {(view?.ownerEmail[0] ?? "S").toUpperCase()}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left rail: minimal — calendar visibility toggles */}
        <nav className="gc-scroll w-[240px] shrink-0 overflow-y-auto px-4 pt-4">
          <div className="pb-2 text-sm font-medium text-[#3c4043]">My calendars</div>
          {calendars.map((c) => {
            const color = calendarColor(calendars, c.id);
            const checked = !hidden.has(c.id);
            return (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-3 rounded px-1 py-1.5 text-sm text-[#3c4043] hover:bg-gc-hover"
                title={`${c.id} · ${c.accessRole} · ${c.timeZone}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setHidden((h) => {
                      const next = new Set(h);
                      if (next.has(c.id)) next.delete(c.id);
                      else next.add(c.id);
                      return next;
                    })
                  }
                  className="h-4 w-4 accent-current"
                  style={{ color, accentColor: color }}
                />
                <span className="truncate">{c.summary}</span>
              </label>
            );
          })}
        </nav>

        {/* Week grid */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col pb-3 pr-3">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gc-border bg-white">
            {days ? (
              <WeekGrid
                days={days}
                timeZone={timeZone}
                events={visibleEvents}
                nowMs={nowMs}
                colorFor={colorFor}
                onEventClick={setSelected}
              />
            ) : (
              <div className="p-6 text-sm text-gc-muted">Loading calendar…</div>
            )}
          </div>
        </main>

        {showActivity && <ActivityPanel data={activity} />}
      </div>

      {selected && (
        <EventPopover
          event={selected.event}
          anchor={selected.rect}
          timeZone={timeZone}
          calendarName={
            calendars.find((c) => c.id === selected.event.calendarId)?.summary ??
            selected.event.calendarId
          }
          color={colorFor(selected.event.calendarId)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
