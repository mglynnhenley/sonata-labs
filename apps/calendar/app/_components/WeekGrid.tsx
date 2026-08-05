"use client";

import { useEffect, useMemo, useRef } from "react";
import type { GridEvent } from "./types";
import type { DayInfo } from "./time";
import { minutesIntoDay, wallParts, sameWallDay, hourLabel, gmtLabel, clockLabel } from "./time";

export const HOUR_PX = 48;
const DAY_MIN = 24 * 60;
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export interface EventClick {
  event: GridEvent;
  /** Viewport rect of the clicked block, for popover placement. */
  rect: DOMRect;
}

interface TimedSlice {
  event: GridEvent;
  startMin: number;
  endMin: number;
  col: number;
  cols: number;
}

/**
 * Side-by-side split for overlapping events, per day column: greedy column
 * assignment inside each cluster of transitively-overlapping slices, then every
 * slice in a cluster shares the cluster's column count so widths line up.
 */
function layoutDay(slices: Array<Omit<TimedSlice, "col" | "cols">>): TimedSlice[] {
  const sorted = [...slices].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin || a.event.id.localeCompare(b.event.id),
  );
  const placed: TimedSlice[] = [];
  let cluster: TimedSlice[] = [];
  let colEnds: number[] = []; // colEnds[i] = end of the latest slice in column i
  let clusterEnd = -1;

  const flush = () => {
    const cols = colEnds.length;
    for (const s of cluster) s.cols = cols;
    cluster = [];
    colEnds = [];
    clusterEnd = -1;
  };

  for (const s of sorted) {
    if (s.startMin >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= s.startMin);
    if (col === -1) col = colEnds.length;
    colEnds[col] = s.endMin;
    const item: TimedSlice = { ...s, col, cols: 1 };
    cluster.push(item);
    placed.push(item);
    clusterEnd = Math.max(clusterEnd, s.endMin);
  }
  flush();
  return placed;
}

export function WeekGrid({
  days,
  timeZone,
  events,
  nowMs,
  colorFor,
  onEventClick,
}: {
  days: DayInfo[];
  timeZone: string;
  events: GridEvent[];
  nowMs: number;
  colorFor: (calendarId: string) => string;
  onEventClick: (click: EventClick) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const weekStart = days[0]?.startMs ?? 0;
  const weekEnd = (days[6]?.startMs ?? 0) + 86_400_000;

  const nowParts = wallParts(nowMs, timeZone);
  const todayIdx = days.findIndex((d) => sameWallDay(wallParts(d.startMs, timeZone), nowParts));

  // Slice timed events into per-day segments (a 9 PM – 1 AM call renders in
  // both columns), then resolve overlaps per day.
  const timedByDay = useMemo(() => {
    const perDay: Array<Array<Omit<TimedSlice, "col" | "cols">>> = days.map(() => []);
    for (const ev of events) {
      if (ev.allDay) continue;
      for (let i = 0; i < days.length; i++) {
        const dayStart = days[i]!.startMs;
        const dayEnd = dayStart + 86_400_000;
        if (ev.endMs <= dayStart || ev.startMs >= dayEnd) continue;
        const startMin = ev.startMs <= dayStart ? 0 : minutesIntoDay(ev.startMs, timeZone);
        const endMin = ev.endMs >= dayEnd ? DAY_MIN : minutesIntoDay(ev.endMs, timeZone);
        // 30-minute visual minimum so short events keep a readable title.
        perDay[i]!.push({ event: ev, startMin, endMin: Math.max(endMin, startMin + 30) });
      }
    }
    return perDay.map(layoutDay);
  }, [events, days, timeZone]);

  const allDay = useMemo(
    () =>
      events
        .filter((ev) => ev.allDay && ev.endMs > weekStart && ev.startMs < weekEnd)
        .map((ev) => {
          const startIdx = days.findIndex(
            (d, i) => ev.startMs < d.startMs + 86_400_000 && (i === 0 || ev.startMs >= d.startMs),
          );
          const from = Math.max(startIdx, 0);
          let to = from;
          while (to + 1 < days.length && ev.endMs > days[to + 1]!.startMs) to++;
          return { ev, from, to };
        }),
    [events, days, weekStart, weekEnd],
  );

  // Open on the working morning, not midnight.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 7.5 * HOUR_PX });
  }, []);

  const nowTop = todayIdx >= 0 ? (minutesIntoDay(nowMs, timeZone) / 60) * HOUR_PX : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day headers + all-day strip */}
      <div className="shrink-0 border-b border-gc-grid pr-3">
        <div className="grid" style={{ gridTemplateColumns: "56px repeat(7, 1fr)" }}>
          <div className="flex items-end justify-end pb-1 pr-2">
            <span
              className="text-[10px] text-gc-muted"
              title={`Times shown in ${timeZone} — the calendar's stored time zone`}
            >
              {gmtLabel(weekStart, timeZone)}
            </span>
          </div>
          {days.map((d, i) => {
            const isToday = i === todayIdx;
            return (
              <div key={d.startMs} className="flex flex-col items-center pb-1 pt-2">
                <span className={`text-[11px] font-medium ${isToday ? "text-[#1a73e8]" : "text-gc-muted"}`}>
                  {DAY_NAMES[d.weekday]}
                </span>
                <span
                  className={`mt-0.5 flex h-[46px] w-[46px] items-center justify-center rounded-full text-[26px] ${
                    isToday ? "bg-[#1a73e8] font-medium text-white" : "font-normal text-[#3c4043] hover:bg-gc-hover"
                  }`}
                >
                  {d.day}
                </span>
              </div>
            );
          })}
        </div>
        {allDay.length > 0 && (
          <div
            className="relative mb-1 grid gap-y-0.5"
            style={{ gridTemplateColumns: "56px repeat(7, 1fr)" }}
          >
            {allDay.map(({ ev, from, to }) => (
              <button
                key={ev.id}
                onClick={(e) => onEventClick({ event: ev, rect: e.currentTarget.getBoundingClientRect() })}
                className="mx-0.5 truncate rounded px-2 py-0.5 text-left text-xs font-medium text-white"
                style={{
                  gridColumn: `${from + 2} / ${to + 3}`,
                  backgroundColor: colorFor(ev.calendarId),
                  textDecoration: ev.declinedByOwner ? "line-through" : undefined,
                }}
              >
                {ev.summary}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Hour grid */}
      <div ref={scrollRef} className="gc-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="relative grid" style={{ gridTemplateColumns: "56px repeat(7, 1fr)", height: 24 * HOUR_PX }}>
          {/* Time gutter */}
          <div className="relative border-r border-gc-grid">
            {Array.from({ length: 24 }, (_, h) => (
              <span
                key={h}
                className="absolute right-2 text-[10px] text-gc-muted"
                style={{ top: h * HOUR_PX - 6 }}
              >
                {hourLabel(h)}
              </span>
            ))}
          </div>

          {days.map((d, i) => (
            <div
              key={d.startMs}
              className={`relative border-r border-gc-grid ${i === todayIdx ? "bg-[#e8f0fe]/30" : ""}`}
            >
              {Array.from({ length: 23 }, (_, h) => (
                <div
                  key={h}
                  className="absolute inset-x-0 border-b border-gc-grid"
                  style={{ top: (h + 1) * HOUR_PX }}
                />
              ))}

              {timedByDay[i]!.map((s) => {
                const color = colorFor(s.event.calendarId);
                const declined = s.event.declinedByOwner;
                const top = (s.startMin / 60) * HOUR_PX;
                const height = ((s.endMin - s.startMin) / 60) * HOUR_PX;
                return (
                  <button
                    key={`${s.event.id}:${i}`}
                    onClick={(e) =>
                      onEventClick({ event: s.event, rect: e.currentTarget.getBoundingClientRect() })
                    }
                    className="absolute overflow-hidden rounded px-1.5 py-0.5 text-left text-xs leading-tight shadow-[0_1px_2px_rgba(60,64,67,0.3)] hover:shadow-[0_2px_6px_rgba(60,64,67,0.4)]"
                    style={{
                      top,
                      height: height - 2,
                      left: `calc(${(s.col / s.cols) * 100}% + 1px)`,
                      width: `calc(${(1 / s.cols) * 100}% - 3px)`,
                      // Declined events render hollow with struck text, like Google.
                      backgroundColor: declined ? "#ffffff" : color,
                      border: declined ? `1px solid ${color}` : undefined,
                      color: declined ? color : "#ffffff",
                      textDecoration: declined ? "line-through" : undefined,
                      zIndex: 2 + s.col,
                    }}
                  >
                    <span className="font-medium">{s.event.summary}</span>
                    {height >= 32 && (
                      <span className="block truncate opacity-90">
                        {clockLabel(s.event.startMs, timeZone)} – {clockLabel(s.event.endMs, timeZone)}
                      </span>
                    )}
                  </button>
                );
              })}

              {/* Red now-line, only in today's column */}
              {i === todayIdx && (
                <div className="pointer-events-none absolute inset-x-0 z-10" style={{ top: nowTop }}>
                  <div className="relative h-[2px] bg-gc-now">
                    <div className="absolute -left-[6px] -top-[5px] h-3 w-3 rounded-full bg-gc-now" />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
