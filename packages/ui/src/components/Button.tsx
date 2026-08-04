"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "relative inline-flex select-none items-center justify-center gap-2 rounded-sn-md border font-medium " +
  "transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-sn " +
  "active:translate-y-px disabled:pointer-events-none disabled:active:translate-y-0";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-sn-primary text-sn-on-primary shadow-sn-xs hover:bg-sn-primary-hover active:bg-sn-primary-active",
  secondary:
    "border-sn-line bg-sn-surface text-sn-ink shadow-sn-xs hover:border-sn-line-strong hover:bg-sn-surface-hover",
  ghost: "border-transparent bg-transparent text-sn-muted hover:bg-sn-bg-subtle hover:text-sn-ink",
  danger:
    "border-transparent bg-sn-danger text-white shadow-sn-xs hover:bg-sn-danger-hover active:bg-sn-danger-hover",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[12px]",
  md: "h-9 px-3.5 text-[13px]",
  lg: "h-11 px-5 text-[15px]",
};

const ICON_SIZES: Record<ButtonSize, string> = {
  sm: "h-7 w-7 px-0",
  md: "h-9 w-9 px-0",
  lg: "h-11 w-11 px-0",
};

/** Exported so links and other elements can wear the same clothes. */
export function buttonClasses(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  options: { iconOnly?: boolean; block?: boolean; loading?: boolean } = {},
): string {
  return cn(
    BASE,
    VARIANTS[variant],
    options.iconOnly ? ICON_SIZES[size] : SIZES[size],
    options.block && "w-full",
    // A loading button is busy, not unavailable — it must not fade out.
    !options.loading && "disabled:opacity-45",
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Keeps the label in place and swaps in a spinner, so the button never resizes. */
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  /** Square button. Pass `aria-label` — there is no visible text to read. */
  iconOnly?: boolean;
  block?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    icon,
    iconRight,
    iconOnly = false,
    block = false,
    type = "button",
    disabled,
    className,
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonClasses(variant, size, { iconOnly, block, loading }), className)}
      {...rest}
    >
      {loading ? (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner size={size === "lg" ? "md" : "sm"} label="" />
        </span>
      ) : null}
      <span
        className={cn(
          "inline-flex items-center justify-center gap-2",
          loading && "invisible",
        )}
      >
        {icon}
        {children}
        {iconRight}
      </span>
      {loading ? <span className="sr-only">Working…</span> : null}
    </button>
  );
});
