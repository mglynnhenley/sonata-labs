"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../cn";

export type TabItem = {
  id: string;
  label: ReactNode;
  /** Small trailing count — how many runs, how many findings. */
  count?: ReactNode;
  disabled?: boolean;
};

export type TabsVariant = "underline" | "pill";

export type TabsProps = {
  items: readonly TabItem[];
  value: string;
  onValueChange: (id: string) => void;
  variant?: TabsVariant;
  /** Set when a page has more than one Tabs, so the ARIA ids stay unique. */
  idPrefix?: string;
  label?: string;
  className?: string;
};

export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const tabPanelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

/**
 * Automatic activation: arrows move focus *and* select, which is what people
 * expect when the panels are cheap to render.
 */
export function Tabs({
  items,
  value,
  onValueChange,
  variant = "underline",
  idPrefix = "sn",
  label = "Sections",
  className,
}: TabsProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const enabled = items.filter((item) => !item.disabled);
    if (enabled.length === 0) return;

    const current = enabled.findIndex((item) => item.id === value);
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % enabled.length;
    if (event.key === "ArrowLeft") next = (current - 1 + enabled.length) % enabled.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = enabled.length - 1;

    const target = enabled[next];
    if (!target) return;
    event.preventDefault();
    onValueChange(target.id);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(idPrefix, target.id))}`)
      ?.focus();
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex items-center gap-1",
        variant === "underline" && "border-b border-sn-line",
        variant === "pill" && "rounded-full border border-sn-line bg-sn-bg-subtle p-1",
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            id={tabId(idPrefix, item.id)}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={tabPanelId(idPrefix, item.id)}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onValueChange(item.id)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 px-3 text-sn-base font-medium whitespace-nowrap",
              "transition-[color,background-color,border-color] duration-150 ease-sn",
              "disabled:pointer-events-none disabled:opacity-45",
              variant === "underline" &&
                cn(
                  "-mb-px border-b-2",
                  selected
                    ? "border-sn-primary text-sn-ink"
                    : "border-transparent text-sn-muted hover:text-sn-ink",
                ),
              variant === "pill" &&
                cn(
                  "rounded-full",
                  selected
                    ? "bg-sn-surface text-sn-ink shadow-sn-xs"
                    : "text-sn-muted hover:text-sn-ink",
                ),
            )}
          >
            {item.label}
            {item.count !== undefined && item.count !== null ? (
              <span
                data-numeric
                className={cn(
                  "rounded-full px-1.5 text-sn-xs",
                  selected ? "bg-sn-primary-soft text-sn-primary-ink" : "bg-sn-bg-subtle text-sn-subtle",
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export type TabPanelProps = {
  /** Must match the TabItem id. */
  id: string;
  active: boolean;
  idPrefix?: string;
  children: ReactNode;
  className?: string;
};

export function TabPanel({ id, active, idPrefix = "sn", children, className }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={tabPanelId(idPrefix, id)}
      aria-labelledby={tabId(idPrefix, id)}
      hidden={!active}
      tabIndex={0}
      className={cn(active && "animate-sn-fade-in", className)}
    >
      {active ? children : null}
    </div>
  );
}
