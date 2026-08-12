"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { Spinner } from "./Spinner";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./buttonClasses";

// The class strings live in ./buttonClasses (no "use client"), so a server
// component can dress a link as a button without importing this module.
export { buttonClasses };
export type { ButtonSize, ButtonVariant };

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
