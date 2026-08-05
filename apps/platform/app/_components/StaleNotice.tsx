"use client";

import { useEffect, useState } from "react";
import { IconAlert } from "@sonata/ui";
import { ago } from "@/lib/format";
import type { Poll } from "./usePoll";

// What a live page says when it stops being live.
//
// `usePoll` keeps the last good data on screen when a request fails, which is
// the right call — a dashboard that blanks itself because one poll missed is
// worse than one that is a few seconds behind. But the spec's rule is "live,
// never stale", and a page that has quietly frozen while still looking current
// is exactly the stale it is warning about. So the moment polling stops
// working, the page says so, says how old what you are reading is, and offers
// the one thing that helps.

export interface StaleNoticeProps {
  /** The poll this page is driven by. Nothing renders while it is healthy. */
  poll: Pick<Poll<unknown>, "error" | "updatedAt" | "refresh">;
  /** What has stopped updating: "the overview", "the run list". */
  what: string;
}

export function StaleNotice({ poll, what }: StaleNoticeProps) {
  // The age has to keep counting up on its own — the whole point is that no new
  // data is arriving, so nothing else would re-render this.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!poll.error) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [poll.error]);

  if (!poll.error) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-sn-lg border border-sn-line-strong bg-sn-gold-soft px-4 py-2.5"
    >
      <IconAlert size={14} className="shrink-0 text-sn-gold-ink" />
      <p className="text-[13px] leading-[20px] text-sn-ink">
        This page has stopped updating — {what} was last read {ago(poll.updatedAt, now)}.
      </p>
      <button
        type="button"
        onClick={poll.refresh}
        className="rounded-sn-sm text-[13px] font-medium text-sn-primary-ink underline-offset-2 transition-colors duration-150 ease-sn hover:underline"
      >
        Try now
      </button>
      <span className="text-[12px] text-sn-subtle">{poll.error}</span>
    </div>
  );
}
