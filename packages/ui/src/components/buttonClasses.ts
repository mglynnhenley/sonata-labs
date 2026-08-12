import { cn } from "../cn";

/**
 * The button's clothes, without the button.
 *
 * Deliberately its own module with no "use client" directive. This lives where
 * anything can reach it — the not-found and error pages are server components,
 * and importing it from Button.tsx meant calling a function out of a client
 * module from the server, which throws. It builds a string and touches no React
 * API, so nothing about it needed to be client-only in the first place.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export const BUTTON_BASE =
  "relative inline-flex select-none items-center justify-center gap-2 rounded-sn-md border font-medium " +
  "transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-sn " +
  "active:translate-y-px disabled:pointer-events-none disabled:active:translate-y-0";

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-sn-primary text-sn-on-primary shadow-sn-xs hover:bg-sn-primary-hover active:bg-sn-primary-active",
  secondary:
    "border-sn-line bg-sn-surface text-sn-ink shadow-sn-xs hover:border-sn-line-strong hover:bg-sn-surface-hover",
  ghost: "border-transparent bg-transparent text-sn-muted hover:bg-sn-bg-subtle hover:text-sn-ink",
  danger:
    "border-transparent bg-sn-danger text-white shadow-sn-xs hover:bg-sn-danger-hover active:bg-sn-danger-hover",
};

export const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[12px]",
  md: "h-9 px-3.5 text-[13px]",
  lg: "h-11 px-5 text-[15px]",
};

export const BUTTON_ICON_SIZES: Record<ButtonSize, string> = {
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
    BUTTON_BASE,
    BUTTON_VARIANTS[variant],
    options.iconOnly ? BUTTON_ICON_SIZES[size] : BUTTON_SIZES[size],
    options.block && "w-full",
    // A loading button is busy, not unavailable — it must not fade out.
    !options.loading && "disabled:opacity-45",
  );
}
