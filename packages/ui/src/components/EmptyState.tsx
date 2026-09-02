import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { IconCheck } from "./icons";

export type EmptyStateSize = "sm" | "md";

export type EmptyStateProps = HTMLAttributes<HTMLDivElement> & {
  icon?: ReactNode;
  title: ReactNode;
  /** What will live here and why it matters. Two sentences, plain language. */
  description?: ReactNode;
  /** "What you'll see here" — the teaching part. Three at most. */
  hints?: readonly ReactNode[];
  /** The one button to press next. */
  action?: ReactNode;
  secondaryAction?: ReactNode;
  size?: EmptyStateSize;
  /** Dashed outline. Off when the state already sits inside a Card. */
  bordered?: boolean;
};

/**
 * Empty states must teach, per the spec: what lives here, why it matters, and
 * the single next action. Never a bare "No results".
 */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  {
    icon,
    title,
    description,
    hints,
    action,
    secondaryAction,
    size = "md",
    bordered = true,
    className,
    children,
    ...rest
  },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex flex-col items-center text-center",
        size === "md" ? "px-8 py-14" : "px-6 py-9",
        bordered && "rounded-sn-3xl border border-dashed border-sn-line-strong bg-sn-surface/60",
        className,
      )}
      {...rest}
    >
      {icon ? (
        <span className="mb-5 grid h-12 w-12 place-items-center rounded-full border border-sn-gold-soft bg-sn-gold-soft text-sn-gold-ink">
          {icon}
        </span>
      ) : null}

      <h2
        className={cn(
          "font-display text-balance text-sn-ink",
          size === "md" ? "text-sn-3xl" : "text-sn-2xl",
        )}
      >
        {title}
      </h2>

      {description ? (
        <p className="mt-2.5 max-w-[46ch] text-sn-md text-sn-muted">{description}</p>
      ) : null}

      {hints?.length ? (
        <ul className="mt-6 flex flex-col items-start gap-2 text-left text-sn-base text-sn-muted">
          {hints.map((hint, i) => (
            <li key={i} className="flex items-start gap-2">
              <IconCheck size="sm" className="mt-0.5 shrink-0 text-sn-gold" />
              <span>{hint}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {children}

      {action || secondaryAction ? (
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
});
