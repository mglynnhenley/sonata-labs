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
          <p className="mb-2 text-[11px] font-medium tracking-[0.08em] text-sn-subtle uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1
          className={cn("font-display text-sn-ink", size === "lg" ? "text-[46px]" : "text-[36px]")}
        >
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-2 max-w-[62ch] text-[14px] leading-[22px] text-sn-muted">{subtitle}</p>
        ) : null}
        {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>

      {actions ? <div className="flex shrink-0 items-center gap-2.5">{actions}</div> : null}
    </header>
  );
});
