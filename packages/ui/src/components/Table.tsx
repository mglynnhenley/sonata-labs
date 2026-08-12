"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "../cn";

export type Column<T> = {
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  align?: "left" | "right" | "center";
  /** Any CSS width; drives a <colgroup> so columns do not jump between pages. */
  width?: string;
  className?: string;
  headerClassName?: string;
};

export type TableProps<T> = {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  /** Makes rows focusable and Enter/Space-activatable. */
  onRowClick?: (row: T, index: number) => void;
  /**
   * Where the row goes. Wraps the first cell in a real anchor, so a row that is
   * navigation survives middle-click, Cmd-click and "copy link address" —
   * `onRowClick` alone is a handler on a `<tr>` and none of those reach it.
   */
  rowHref?: (row: T, index: number) => string;
  /** Screen-reader name for a clickable row: "Run 12, passed". */
  rowLabel?: (row: T, index: number) => string;
  /** Highlights the row the run view is currently parked on. */
  isRowActive?: (row: T, index: number) => boolean;
  /** Shown in place of the body — pass an EmptyState. */
  empty?: ReactNode;
  dense?: boolean;
  stickyHeader?: boolean;
  caption?: ReactNode;
  className?: string;
};

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

/**
 * Quiet, dense, hoverable. No zebra striping — a hairline between rows reads
 * calmer at the row counts a run produces.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowHref,
  rowLabel,
  isRowActive,
  empty,
  dense = false,
  stickyHeader = false,
  caption,
  className,
}: TableProps<T>) {
  const cellPad = dense ? "px-3 py-1.5" : "px-4 py-2.5";

  function handleKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: T, index: number) {
    if (!onRowClick) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onRowClick(row, index);
  }

  if (rows.length === 0 && empty) {
    return <div className={className}>{empty}</div>;
  }

  return (
    <div
      className={cn(
        // sn-scroll-x carries the background and shades whichever edge still has
        // columns behind it, so a table wider than its card says so.
        "sn-scroll sn-scroll-x rounded-sn-2xl border border-sn-line",
        className,
      )}
    >
      <table className="w-full border-collapse text-[13px]">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={column.width ? { width: column.width } : undefined} />
          ))}
        </colgroup>
        <thead
          className={cn(
            "border-b border-sn-line bg-sn-surface",
            stickyHeader && "sticky top-0 z-10",
          )}
        >
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  cellPad,
                  "text-[11px] font-medium tracking-[0.06em] text-sn-subtle uppercase",
                  ALIGN[column.align ?? "left"],
                  column.headerClassName,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const active = isRowActive?.(row, index) ?? false;
            return (
              <tr
                key={rowKey(row, index)}
                tabIndex={onRowClick ? 0 : undefined}
                aria-label={onRowClick ? rowLabel?.(row, index) : undefined}
                onClick={onRowClick ? () => onRowClick(row, index) : undefined}
                onKeyDown={(event) => handleKeyDown(event, row, index)}
                className={cn(
                  "border-b border-sn-line/70 transition-colors duration-150 ease-sn last:border-b-0",
                  onRowClick && "cursor-pointer hover:bg-sn-surface-hover",
                  active && "bg-sn-primary-soft/60",
                )}
              >
                {columns.map((column, columnIndex) => {
                  const content = column.render(row, index);
                  const href = columnIndex === 0 ? rowHref?.(row, index) : undefined;
                  return (
                    <td
                      key={column.key}
                      className={cn(
                        cellPad,
                        "align-middle text-sn-ink",
                        ALIGN[column.align ?? "left"],
                        column.className,
                      )}
                    >
                      {href ? (
                        // The row already owns the click and the focus ring; this
                        // anchor exists so the browser's own gestures work. A
                        // modifier click falls through to the native href and
                        // opens a tab; a plain click defers to onRowClick, which
                        // routes on the client instead of reloading the page.
                        <a
                          href={href}
                          tabIndex={-1}
                          className="block focus:outline-none"
                          onClick={(event) => {
                            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                              event.stopPropagation();
                              return;
                            }
                            event.preventDefault();
                          }}
                        >
                          {content}
                        </a>
                      ) : (
                        content
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className={cn(cellPad, "py-10 text-center text-[13px] text-sn-subtle")}
              >
                Nothing here yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
