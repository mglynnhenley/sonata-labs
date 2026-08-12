"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../cn";
import { IconClose } from "./icons";

export type ModalSize = "sm" | "md" | "lg";

const SIZES: Record<ModalSize, string> = {
  sm: "max-w-[420px]",
  md: "max-w-[560px]",
  lg: "max-w-[760px]",
};

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** One line under the title saying what this does. */
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned. Primary last. */
  footer?: ReactNode;
  size?: ModalSize;
  /** Off for destructive confirmations that must be answered. */
  dismissible?: boolean;
  className?: string;
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
  className,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => setMounted(true), []);

  const close = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  // Focus moves in on open and back to the trigger on close; the page behind
  // must not scroll while the dialog owns the screen.
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const target = dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog;
      target.focus();
    });

    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === dialog,
      );
      if (items.length === 0) return;

      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [close],
  );

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center overscroll-contain p-4"
      onKeyDown={onKeyDown}
    >
      <div
        className="animate-sn-fade-in absolute inset-0 bg-[#1b1a17]/35 backdrop-blur-[1px]"
        onClick={close}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "animate-sn-pop relative w-full rounded-sn-3xl border border-sn-line bg-sn-surface p-6 shadow-sn-lg",
          // Opening the dialog locks body scroll, so anything taller than the
          // viewport would be stranded off-screen with nothing left to scroll.
          // The dialog itself scrolls instead.
          "sn-scroll max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain",
          SIZES[size],
          className,
        )}
      >
        {dismissible ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute top-4 right-4 rounded-sn-md p-1.5 text-sn-subtle transition-colors duration-150 ease-sn hover:bg-sn-bg-subtle hover:text-sn-ink"
          >
            <IconClose size={16} />
          </button>
        ) : null}

        <h2 id={titleId} className="font-display pr-8 text-[26px] text-sn-ink">
          {title}
        </h2>
        {description ? (
          <p id={descriptionId} className="mt-2 text-[13px] leading-[20px] text-sn-muted">
            {description}
          </p>
        ) : null}

        {children ? <div className="mt-5 text-[14px] text-sn-ink">{children}</div> : null}

        {footer ? (
          <div className="mt-7 flex items-center justify-end gap-2.5">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
