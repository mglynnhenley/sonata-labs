"use client";

import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type MouseEventHandler,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "../cn";
import { IconChevronRight, IconClose, IconMenu } from "./icons";

/** The one breakpoint the shell pivots on: below it the sidebar is a drawer. */
const DESKTOP = "(min-width: 1024px)";

/** Shared so SidebarTrigger's aria-controls points at the drawer it opens. */
const SIDEBAR_ID = "sn-sidebar";

/** The drawer needs its own handle on the element as well as the caller's. */
function mergeRefs<T>(...refs: (Ref<T> | undefined)[]) {
  return (value: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(value);
      else if (ref) (ref as { current: T | null }).current = value;
    }
  };
}

/**
 * Whether the viewport is wide enough for the sidebar to stand beside the
 * content — `undefined` until the client has actually measured.
 *
 * The third state matters. Guessing `false` on the server would render the
 * desktop sidebar `inert`, so with JavaScript disabled the whole navigation
 * would be permanently unreachable. Undefined means "do not claim yet", and
 * only the CSS breakpoint is in charge until the answer arrives.
 */
function useDesktop(): boolean | undefined {
  const [desktop, setDesktop] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    const query = window.matchMedia(DESKTOP);
    const sync = () => setDesktop(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return desktop;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export type SidebarProps = HTMLAttributes<HTMLElement> & {
  /** Wordmark block at the top. */
  brand?: ReactNode;
  /** Pinned to the bottom — the user block. */
  footer?: ReactNode;
  /** Accessible name when a page has more than one nav. */
  label?: string;
  /** Below `lg` the sidebar slides off-canvas; this opens it. Ignored above. */
  open?: boolean;
  /** Escape, the backdrop and the close button all call this. */
  onClose?: () => void;
};

/**
 * Beside the content on a wide screen, a drawer on a narrow one.
 *
 * The 252px column used to be unconditional, which left a phone about 140px to
 * read a dashboard in — headlines broke one word per line. Below `lg` it now
 * sits off-canvas and slides in over a backdrop.
 */
export const Sidebar = forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { brand, footer, label = "Main", open = false, onClose, id = SIDEBAR_ID, className, children, ...rest },
  ref,
) {
  const desktop = useDesktop();
  const asideRef = useRef<HTMLElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  // Only a drawer is modal. Beside the content it is just part of the page.
  const drawerOpen = open && desktop === false;

  // Escape closes, focus moves in and back out, and the page behind must not
  // scroll while the drawer covers it — the same contract Modal keeps.
  useEffect(() => {
    if (!drawerOpen || !onClose) return;

    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      // Tab must not walk out of an open drawer into the page it is covering.
      const aside = asideRef.current;
      if (!aside) return;
      const items = Array.from(aside.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) return;

      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    const frame = requestAnimationFrame(() => {
      const aside = asideRef.current;
      aside?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });

    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      restoreTo.current?.focus();
    };
  }, [drawerOpen, onClose]);

  return (
    <>
      {/* Backdrop, drawer only. aria-hidden: Escape and the close button are the
          documented ways out, so this need not be reachable. */}
      {drawerOpen ? (
        <div
          className="animate-sn-fade-in fixed inset-0 z-40 bg-[#16181a]/35 backdrop-blur-[1px] lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      ) : null}

      <aside
        ref={mergeRefs(ref, asideRef)}
        id={id}
        // Closed and off-canvas, it is still in the document: hide it from the
        // reading order and the tab ring rather than leaving a nav nobody can
        // see. Only once the client has measured — see useDesktop.
        inert={desktop === false && !open ? true : undefined}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-dvh w-[252px] flex-col border-r border-sn-line bg-sn-surface",
          "overscroll-contain transition-transform duration-200 ease-sn-out",
          open ? "translate-x-0 shadow-sn-lg" : "-translate-x-full",
          // Above the breakpoint it is a column in the flex row again, never
          // translated and never floating.
          "lg:sticky lg:top-0 lg:z-auto lg:translate-x-0 lg:shrink-0 lg:shadow-none",
          className,
        )}
        {...rest}
      >
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="absolute top-5 right-3 rounded-sn-md p-1.5 text-sn-subtle transition-colors duration-150 ease-sn hover:bg-sn-bg-subtle hover:text-sn-ink lg:hidden"
          >
            <IconClose size="md" />
          </button>
        ) : null}

        {brand ? <div className="px-5 pt-6 pb-5">{brand}</div> : null}
        <nav
          aria-label={label}
          className="sn-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4"
        >
          {children}
        </nav>
        {footer ? <div className="border-t border-sn-line p-3">{footer}</div> : null}
      </aside>
    </>
  );
});

export type SidebarTriggerProps = {
  onClick: () => void;
  /** Controls the drawer, so it must say whether the drawer is open. */
  open: boolean;
  /** Wordmark, so a narrow screen still names the product. */
  brand?: ReactNode;
  className?: string;
};

/**
 * The bar that stands in for the sidebar below `lg`. Sticky, so navigation is
 * one tap away however far down the page you are.
 */
export function SidebarTrigger({ onClick, open, brand, className }: SidebarTriggerProps) {
  return (
    <div
      className={cn(
        "sticky top-0 z-30 flex items-center gap-3 border-b border-sn-line bg-sn-surface/85 px-4 py-3 backdrop-blur-md lg:hidden",
        className,
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label="Open navigation"
        aria-expanded={open}
        aria-controls={SIDEBAR_ID}
        className="-ml-1.5 rounded-sn-md p-1.5 text-sn-muted transition-colors duration-150 ease-sn hover:bg-sn-surface-hover hover:text-sn-ink"
      >
        <IconMenu size="lg" />
      </button>
      {brand}
    </div>
  );
}

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
  {
    icon,
    active = false,
    count,
    trailing,
    disabled = false,
    href,
    // Destructured so they cannot land on the <button> branch, where `target`
    // and `rel` are not valid attributes.
    target,
    rel,
    className,
    children,
    onClick,
    ...rest
  },
  ref,
) {
  const classes = cn(
    "group flex h-9 w-full items-center gap-2.5 rounded-sn-md px-2.5 text-[13px] font-medium",
    "transition-[background-color,color,box-shadow] duration-150 ease-sn",
    active
      ? "border border-sn-line bg-sn-bg text-sn-ink"
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
          // A disabled item keeps no href: pointer-events-none stops the mouse,
          // but an href would still leave it tabbable and Enter would navigate.
          href={disabled ? undefined : href}
          target={target}
          rel={rel}
          role={disabled ? "link" : undefined}
          tabIndex={disabled ? -1 : undefined}
          aria-current={active ? "page" : undefined}
          aria-disabled={disabled || undefined}
          onClick={disabled ? undefined : onClick}
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
          size="sm"
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
