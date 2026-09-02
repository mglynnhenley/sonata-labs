import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";

export type PageHeaderProps = HTMLAttributes<HTMLElement> & {
  /** Small uppercase kicker above the title: section, breadcrumb, run id. */
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned buttons. Primary action last. */
  actions?: ReactNode;
  /** Chips, badges or meta that belong under the subtitle. */
  meta?: ReactNode;
  size?: "md" | "lg";
  /** Hairline under the header; off when tabs follow immediately. */
  border?: boolean;
};

export const PageHeader = forwardRef<HTMLElement, PageHeaderProps>(function PageHeader(
  { eyebrow, title, subtitle, actions, meta, size = "md", border = false, className, ...rest },
  ref,
) {
  return (
    <header
      ref={ref}
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-6 gap-y-4",
        border && "border-b border-sn-line pb-5",
        className,
      )}
      {...rest}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-2 text-sn-xs font-medium tracking-[0.08em] text-sn-subtle uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1
          className={cn(
            // Balanced so a two-line title splits evenly instead of leaving one
            // orphan word, and anywhere-breaking so an unbroken run id or model
            // slug cannot push the column wider than the page.
            "font-display text-sn-ink text-balance [overflow-wrap:anywhere]",
            // Satoshi 900 carries more weight per point than the serif it
            // replaced, so the scale steps down: 26/30 reads as big as 36/46 did.
            size === "lg" ? "text-sn-3xl sm:text-sn-3xl" : "text-sn-2xl sm:text-sn-2xl",
          )}
        >
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-2 max-w-[62ch] text-sn-md text-sn-muted">{subtitle}</p>
        ) : null}
        {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>

      {/* shrink-0 keeps the actions at full size beside a long title, but they
          must still wrap: two buttons on a phone are wider than the page, and
          shrink-0 alone would push them off the right edge. */}
      {actions ? (
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2.5">{actions}</div>
      ) : null}
    </header>
  );
});
