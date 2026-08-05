import { cn } from "@sonata/ui";

// The shape of a page before its data has arrived.
//
// Every route here does its reading on the server, so a navigation is a wait
// with nothing on screen unless something stands in. A skeleton in the shape of
// the page that is coming is the version of that wait which does not feel like
// one: the layout never jumps, and the eye is already in the right place when
// the real thing lands.

export interface SkeletonRow {
  /** Height in pixels of each block in the row. */
  height: number;
  /** Side-by-side blocks, from `md` up. One when omitted. */
  columns?: number;
}

export interface PageSkeletonProps {
  /** What is being loaded — announced, never drawn. "Loading the results". */
  label: string;
  rows: readonly SkeletonRow[];
}

const COLUMNS: Record<number, string> = {
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "sm:grid-cols-2 xl:grid-cols-4",
};

export function PageSkeleton({ label, rows }: PageSkeletonProps) {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-8">
      <span className="sr-only">{label}</span>

      <div aria-hidden="true" className="flex flex-col gap-3">
        <span className="sn-skeleton block h-3 w-24" />
        <span className="sn-skeleton block h-8 w-[280px] max-w-full" />
        <span className="sn-skeleton block h-4 w-[440px] max-w-full" />
      </div>

      {rows.map((row, index) => (
        <div
          key={index}
          aria-hidden="true"
          className={cn("grid gap-4", row.columns ? COLUMNS[row.columns] : undefined)}
        >
          {Array.from({ length: row.columns ?? 1 }, (_, cell) => (
            <span
              key={cell}
              className="sn-skeleton block rounded-sn-2xl"
              style={{ height: `${row.height}px` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
