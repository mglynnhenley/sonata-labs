// View-model types live in the BFF layer (src/lib/view-types.ts) since both the
// server routes and these components need them; re-exported here so the
// components' `./types` imports are unchanged from before the split.
export type {
  LabelChip,
  RailLabel,
  ThreadRow,
  ListView,
  ThreadMessageView,
  ThreadView,
  ActionRow,
  SessionRow,
  ActivityData,
} from "@/lib/view-types";

// Gmail-style smart date: time if today, "MMM D" otherwise, "M/D/YY" if old.
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
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
}

export function fullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
