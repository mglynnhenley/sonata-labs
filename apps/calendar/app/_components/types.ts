// Client-side views of the server projections. Type-only imports from src/lib
// keep the shapes in lockstep without pulling better-sqlite3 into the bundle.
import type { WeekView, GridEvent, CalendarSummary } from "@/lib/ui/views";
import type { ActionRow, SessionRow } from "@/lib/audit";

export type { WeekView, GridEvent, CalendarSummary, ActionRow, SessionRow };

export interface ActivityData {
  sessions: SessionRow[];
  actions: ActionRow[];
}

export interface AnchorData {
  anchorMs: number | null;
  timeZone: string;
}

// Google's default event palette; the seeder leaves calendar colors null, so
// each calendar gets a stable color by rail order (primary first = peacock).
const CALENDAR_PALETTE = [
  "#039be5", // peacock
  "#33b679", // sage
  "#7986cb", // lavender
  "#8e24aa", // grape
  "#e67c73", // flamingo
  "#f4511e", // tangerine
  "#0b8043", // basil
];

export function calendarColor(calendars: CalendarSummary[], calendarId: string): string {
  const idx = calendars.findIndex((c) => c.id === calendarId);
  const stored = idx >= 0 ? calendars[idx]?.backgroundColor : null;
  return stored ?? CALENDAR_PALETTE[Math.max(idx, 0) % CALENDAR_PALETTE.length] ?? "#039be5";
}

// Same smart date the Gmail activity panel uses: time if today, else short date.
export function smartDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
}
