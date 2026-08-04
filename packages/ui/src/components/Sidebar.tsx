"use client";

import {
  forwardRef,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type MouseEventHandler,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "../cn";
import { IconChevronRight } from "./icons";

export type SidebarProps = HTMLAttributes<HTMLElement> & {
  /** Wordmark block at the top. */
  brand?: ReactNode;
  /** Pinned to the bottom — the user block. */
  footer?: ReactNode;
  /** Accessible name when a page has more than one nav. */
  label?: string;
};

export const Sidebar = forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { brand, footer, label = "Main", className, children, ...rest },
  ref,
) {
  return (
    <aside
      ref={ref}
      className={cn(
        "sticky top-0 flex h-dvh w-[252px] shrink-0 flex-col border-r border-sn-line bg-sn-bg",
        className,
      )}
      {...rest}
    >
      {brand ? <div className="px-5 pt-6 pb-5">{brand}</div> : null}
      <nav
        aria-label={label}
        className="sn-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4"
      >
        {children}
      </nav>
      {footer ? <div className="border-t border-sn-line p-3">{footer}</div> : null}
    </aside>
  );
});

export type SidebarGroupProps = HTMLAttributes<HTMLDivElement> & { label?: ReactNode };

export const SidebarGroup = forwardRef<HTMLDivElement, SidebarGroupProps>(function SidebarGroup(
  { label, className, children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cn("mb-5", className)} {...rest}>
      {label ? (
        <p className="mb-1.5 px-2.5 text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">
          {label}
        </p>
      ) : null}
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
});

export type SidebarItemProps = HTMLAttributes<HTMLElement> & {
  /** Present ⇒ renders an anchor. */
  href?: string;
  target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"];
  rel?: string;
  icon?: ReactNode;
  /** Marks the current page: aria-current plus the raised pill. */
  active?: boolean;
  /** Right-hand count, e.g. running episodes. */
  count?: ReactNode;
  /** Right-hand node (a Badge) — wins over count. */
  trailing?: ReactNode;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLElement>;
};

/**
 * Renders an <a> when given an href (so Next's Link can wrap it or the href can
 * be used directly) and a <button> otherwise — never a clickable div.
 */
export const SidebarItem = forwardRef<HTMLElement, SidebarItemProps>(function SidebarItem(
  { icon, active = false, count, trailing, disabled = false, href, className, children, onClick, ...rest },
  ref,
) {
  const classes = cn(
    "group flex h-9 w-full items-center gap-2.5 rounded-sn-md px-2.5 text-[13px] font-medium",
    "transition-[background-color,color,box-shadow] duration-150 ease-sn",
    active
      ? "border border-sn-line bg-sn-surface text-sn-ink shadow-sn-xs"
      : "border border-transparent text-sn-muted hover:bg-sn-surface-hover hover:text-sn-ink",
    disabled && "pointer-events-none opacity-45",
    className,
  );

  const inner = (
    <>
      {icon ? (
        <span className={cn("shrink-0", active ? "text-sn-primary" : "text-sn-subtle group-hover:text-sn-muted")}>
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      {trailing ?? (count !== undefined && count !== null ? (
        <span data-numeric className="shrink-0 text-[12px] text-sn-subtle">
          {count}
        </span>
      ) : null)}
    </>
  );

  return (
    <li>
      {href ? (
        <a
          ref={ref as Ref<HTMLAnchorElement>}
          href={href}
          aria-current={active ? "page" : undefined}
          aria-disabled={disabled || undefined}
          onClick={onClick}
          className={classes}
          {...rest}
        >
          {inner}
        </a>
      ) : (
        <button
          ref={ref as Ref<HTMLButtonElement>}
          type="button"
          aria-current={active ? "page" : undefined}
          disabled={disabled}
          onClick={onClick}
          className={classes}
          {...rest}
        >
          {inner}
        </button>
      )}
    </li>
  );
});

export type SidebarUserProps = HTMLAttributes<HTMLElement> & {
  name: ReactNode;
  /** Email, workspace or model — one quiet line. */
  detail?: ReactNode;
  /** Overrides the derived initials. */
  avatar?: ReactNode;
  href?: string;
  onClick?: MouseEventHandler<HTMLElement>;
};

function initials(name: ReactNode): string {
  if (typeof name !== "string") return "·";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "·";
}

/** The block pinned to the bottom of the sidebar. */
export const SidebarUser = forwardRef<HTMLElement, SidebarUserProps>(function SidebarUser(
  { name, detail, avatar, href, onClick, className, ...rest },
  ref,
) {
  const clickable = Boolean(href || onClick);
  const classes = cn(
    "group flex w-full items-center gap-2.5 rounded-sn-lg p-2 text-left",
    "transition-[background-color] duration-150 ease-sn",
    clickable && "hover:bg-sn-surface-hover",
    className,
  );

  const inner = (
    <>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sn-primary-soft text-[12px] font-medium text-sn-primary-ink">
        {avatar ?? initials(name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-sn-ink">{name}</span>
        {detail ? <span className="block truncate text-[12px] text-sn-subtle">{detail}</span> : null}
      </span>
      {clickable ? (
        <IconChevronRight
          size={14}
          className="shrink-0 text-sn-subtle transition-transform duration-150 ease-sn group-hover:translate-x-0.5"
        />
      ) : null}
    </>
  );

  if (href) {
    return (
      <a ref={ref as Ref<HTMLAnchorElement>} href={href} onClick={onClick} className={classes} {...rest}>
        {inner}
      </a>
    );
  }
  if (onClick) {
    return (
      <button
        ref={ref as Ref<HTMLButtonElement>}
        type="button"
        onClick={onClick}
        className={classes}
        {...rest}
      >
        {inner}
      </button>
    );
  }
  return (
    <div ref={ref as Ref<HTMLDivElement>} className={classes} {...rest}>
      {inner}
    </div>
  );
});
