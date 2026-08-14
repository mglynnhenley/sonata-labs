"use client";

import { forwardRef, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { cn } from "../cn";
import { SERVICE_LABELS, type ServiceId } from "../tokens";
import { IconCalendar, IconMail, IconMessage, type IconProps } from "./icons";

export type ChipTone = "neutral" | "gold" | ServiceId;
export type ChipSize = "sm" | "md";

const TONES: Record<ChipTone, string> = {
  neutral: "border-sn-line bg-sn-bg-subtle text-sn-muted",
  gold: "border-sn-gold-soft bg-sn-gold-soft text-sn-gold-ink",
  gmail: "border-sn-gmail-line bg-sn-gmail-soft text-sn-gmail-ink",
  slack: "border-sn-slack-line bg-sn-slack-soft text-sn-slack-ink",
  calendar: "border-sn-calendar-line bg-sn-calendar-soft text-sn-calendar-ink",
};

const SIZES: Record<ChipSize, string> = {
  sm: "h-6 gap-1 px-2 text-sn-xs",
  md: "h-7 gap-1.5 px-2.5 text-sn-sm",
};

const SERVICE_ICONS: Record<ServiceId, (props: IconProps) => ReactNode> = {
  gmail: IconMail,
  slack: IconMessage,
  calendar: IconCalendar,
};

export type ChipProps = HTMLAttributes<HTMLElement> & {
  /** Sets the label, the icon and the hue in one prop. */
  service?: ServiceId;
  tone?: ChipTone;
  size?: ChipSize;
  /** `false` removes the icon; a node replaces it. */
  icon?: ReactNode | false;
  /** Only meaningful with onClick — renders as a toggle. */
  selected?: boolean;
};

/**
 * Service chips ("which twins does this scenario touch?") and small tags.
 * Static by default; give it onClick and it becomes a real toggle button.
 */
export const Chip = forwardRef<HTMLElement, ChipProps>(function Chip(
  { service, tone, size = "md", children, icon, selected, className, onClick, ...rest },
  ref,
) {
  const resolvedTone: ChipTone = tone ?? service ?? "neutral";
  const ServiceIcon = service ? SERVICE_ICONS[service] : undefined;
  const glyph =
    icon === false
      ? null
      : icon !== undefined
        ? icon
        : ServiceIcon
          ? <ServiceIcon size={size === "sm" ? "xs" : "sm"} />
          : null;
  const label = children ?? (service ? SERVICE_LABELS[service] : null);

  // A chip whose only content is an icon has no accessible name: every glyph in
  // the set is aria-hidden, so a screen reader reaches a button and finds
  // nothing to announce. The service name is the label in all but name, so use
  // it; anything else has to say what it is via aria-label.
  const fallbackName = service ? SERVICE_LABELS[service] : undefined;
  const ariaLabel = (rest as { "aria-label"?: string })["aria-label"] ?? (label ? undefined : fallbackName);

  const classes = cn(
    "inline-flex shrink-0 items-center rounded-full border font-medium whitespace-nowrap",
    "transition-[background-color,border-color,box-shadow,opacity] duration-150 ease-sn",
    TONES[resolvedTone],
    SIZES[size],
    onClick && "cursor-pointer",
    // Unselected filters read as "off" without changing the hue.
    onClick && selected === false && "opacity-60 hover:opacity-100",
    selected && "shadow-sn-xs",
    className,
  );

  if (!onClick) {
    return (
      <span ref={ref as Ref<HTMLSpanElement>} className={classes} {...rest}>
        {glyph}
        {label}
      </span>
    );
  }

  return (
    <button
      ref={ref as Ref<HTMLButtonElement>}
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={classes}
      {...rest}
      aria-label={ariaLabel}
    >
      {glyph}
      {label}
    </button>
  );
});
