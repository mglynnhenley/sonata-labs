"use client";

import {
  forwardRef,
  useCallback,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../cn";
import type { ServiceId } from "../tokens";
import { IconChevronDown } from "./icons";

export type TimelineTone = "neutral" | "primary" | "gold" | "passed" | "failed" | ServiceId;

const MARKER_TONES: Record<TimelineTone, string> = {
  neutral: "border-sn-line-strong bg-sn-surface text-sn-subtle",
  primary: "border-sn-primary bg-sn-primary text-sn-on-primary",
  gold: "border-sn-gold bg-sn-gold-soft text-sn-gold-ink",
  passed: "border-sn-passed-line bg-sn-passed-soft text-sn-passed-ink",
  failed: "border-sn-failed-line bg-sn-failed-soft text-sn-failed-ink",
  gmail: "border-sn-gmail-line bg-sn-gmail-soft text-sn-gmail-ink",
  slack: "border-sn-slack-line bg-sn-slack-soft text-sn-slack-ink",
  calendar: "border-sn-calendar-line bg-sn-calendar-soft text-sn-calendar-ink",
  attio: "border-sn-attio-line bg-sn-attio-soft text-sn-attio-ink",
  "google-docs": "border-sn-google-docs-line bg-sn-google-docs-soft text-sn-google-docs-ink",
  "google-ads": "border-sn-google-ads-line bg-sn-google-ads-soft text-sn-google-ads-ink",
  linkedin: "border-sn-linkedin-line bg-sn-linkedin-soft text-sn-linkedin-ink",
};

export type TimelineProps = HTMLAttributes<HTMLOListElement>;

/**
 * The run view's hero: one vertical story anchored to the simulated clock.
 * Arrow keys walk the items, so a replay can be stepped without the mouse.
 */
export const Timeline = forwardRef<HTMLOListElement, TimelineProps>(function Timeline(
  { className, children, onKeyDown, ...rest },
  ref,
) {
  const listRef = useRef<HTMLOListElement | null>(null);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLOListElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
      if (!keys.includes(event.key)) return;

      const list = listRef.current;
      if (!list) return;
      const toggles = Array.from(
        list.querySelectorAll<HTMLButtonElement>("[data-timeline-toggle]"),
      );
      if (toggles.length === 0) return;

      const current = toggles.indexOf(document.activeElement as HTMLButtonElement);
      // Only take over the arrows once focus is inside the story.
      if (current === -1 && event.key !== "Home" && event.key !== "End") return;

      let next = current;
      if (event.key === "ArrowDown") next = Math.min(current + 1, toggles.length - 1);
      if (event.key === "ArrowUp") next = Math.max(current - 1, 0);
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = toggles.length - 1;

      event.preventDefault();
      toggles[next]?.focus();
    },
    [onKeyDown],
  );

  return (
    <ol
      ref={(node) => {
        listRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      className={cn("sn-timeline flex flex-col", className)}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {children}
    </ol>
  );
});

export type TimelineItemProps = {
  /** Simulated clock, e.g. "09:15". Kept in its own gutter so times line up. */
  time?: ReactNode;
  /** Second line in the gutter: tick number, elapsed, date. */
  timeMeta?: ReactNode;
  title: ReactNode;
  /** One quiet line under the title. */
  description?: ReactNode;
  icon?: ReactNode;
  tone?: TimelineTone;
  /** Chips or badges shown to the right of the title. */
  meta?: ReactNode;
  /** Expandable evidence: the message body, the tool call, the judge's reasoning. */
  children?: ReactNode;
  defaultOpen?: boolean;
  /** Controlled disclosure. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The moment the replay is parked on. */
  active?: boolean;
  className?: string;
};

export function TimelineItem({
  time,
  timeMeta,
  title,
  description,
  icon,
  tone = "neutral",
  meta,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  active = false,
  className,
}: TimelineItemProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : uncontrolledOpen;
  const panelId = useId();
  const expandable = Boolean(children);

  function toggle() {
    const next = !isOpen;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  const head = (
    <span className="flex min-w-0 flex-1 items-start gap-2">
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-[13.5px] font-medium text-sn-ink",
            expandable && "group-hover:text-sn-primary-ink",
          )}
        >
          {title}
        </span>
        {description ? (
          <span className="mt-0.5 block text-[13px] leading-[19px] text-sn-muted">
            {description}
          </span>
        ) : null}
      </span>
      {meta ? <span className="flex shrink-0 items-center gap-1.5 pt-0.5">{meta}</span> : null}
      {expandable ? (
        <IconChevronDown
          size={15}
          className={cn(
            "mt-0.5 shrink-0 text-sn-subtle transition-transform duration-150 ease-sn",
            isOpen && "rotate-180",
          )}
        />
      ) : null}
    </span>
  );

  return (
    <li className={cn("group flex gap-3", className)}>
      <div className="w-14 shrink-0 pt-[3px] text-right">
        {time ? (
          <span data-numeric className="block text-[12px] font-medium text-sn-muted">
            {time}
          </span>
        ) : null}
        {timeMeta ? <span className="block text-[11px] text-sn-subtle">{timeMeta}</span> : null}
      </div>

      <div data-rail className="relative flex-1 border-l border-sn-line pb-5 pl-5">
        {/* Marker straddles the rail. */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-0.5 -left-[11px] grid h-[22px] w-[22px] place-items-center rounded-full border",
            MARKER_TONES[tone],
            active && "ring-3 ring-sn-primary-soft",
          )}
        >
          {icon ?? <span className="h-1.5 w-1.5 rounded-full bg-current" />}
        </span>

        {expandable ? (
          <button
            type="button"
            data-timeline-toggle
            aria-expanded={isOpen}
            aria-controls={panelId}
            onClick={toggle}
            className={cn(
              "flex w-full rounded-sn-md px-2 py-1 text-left -mx-2",
              "transition-colors duration-150 ease-sn hover:bg-sn-surface-hover",
              active && "bg-sn-primary-soft/50",
            )}
          >
            {head}
          </button>
        ) : (
          <div className={cn("flex px-2 py-1 -mx-2 rounded-sn-md", active && "bg-sn-primary-soft/50")}>
            {head}
          </div>
        )}

        {expandable ? (
          <div id={panelId} hidden={!isOpen} className="mt-2">
            {isOpen ? (
              <div className="animate-sn-slide-in rounded-sn-lg border border-sn-line bg-sn-bg-subtle p-3 text-[13px] leading-[20px] text-sn-muted">
                {children}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
