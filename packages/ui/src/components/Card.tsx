import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";

export type CardPadding = "none" | "sm" | "md" | "lg";
export type CardTone = "surface" | "sunken" | "outline";
export type CardRadius = "lg" | "xl" | "2xl" | "3xl";

const PADDING: Record<CardPadding, string> = {
  none: "",
  sm: "p-3",
  md: "p-5",
  lg: "p-7",
};

const TONE: Record<CardTone, string> = {
  surface: "border-sn-line bg-sn-surface shadow-sn-xs",
  sunken: "border-sn-line bg-sn-bg-subtle",
  outline: "border-sn-line bg-transparent",
};

const RADIUS: Record<CardRadius, string> = {
  lg: "rounded-sn-lg",
  xl: "rounded-sn-xl",
  "2xl": "rounded-sn-2xl",
  "3xl": "rounded-sn-3xl",
};

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  padding?: CardPadding;
  tone?: CardTone;
  radius?: CardRadius;
  /** Hover lift. Wrap in a link or use StatCard when it is genuinely clickable. */
  interactive?: boolean;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Right side of the header row. */
  actions?: ReactNode;
  footer?: ReactNode;
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    padding = "md",
    tone = "surface",
    radius = "2xl",
    interactive = false,
    title,
    subtitle,
    actions,
    footer,
    className,
    children,
    ...rest
  },
  ref,
) {
  const hasHeader = title !== undefined || subtitle !== undefined || actions !== undefined;
  return (
    <div
      ref={ref}
      className={cn(
        "border transition-[box-shadow,border-color,transform] duration-150 ease-sn",
        RADIUS[radius],
        TONE[tone],
        PADDING[padding],
        interactive && "hover:-translate-y-px hover:border-sn-line-strong hover:shadow-sn-md",
        className,
      )}
      {...rest}
    >
      {hasHeader ? (
        <div className={cn("flex items-start gap-4", padding === "none" && "p-5 pb-0")}>
          <div className="min-w-0 flex-1">
            {title !== undefined ? (
              <h3 className="text-[14px] font-medium text-sn-ink">{title}</h3>
            ) : null}
            {subtitle !== undefined ? (
              <p className="mt-0.5 text-[13px] text-sn-muted">{subtitle}</p>
            ) : null}
          </div>
          {actions !== undefined ? (
            <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : null}

      {children !== undefined ? <div className={cn(hasHeader && "mt-4")}>{children}</div> : null}

      {footer !== undefined ? (
        <div
          className={cn(
            "mt-5 flex items-center gap-3 border-t border-sn-line pt-4 text-[13px] text-sn-muted",
            padding === "none" && "px-5 pb-5",
          )}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
});
