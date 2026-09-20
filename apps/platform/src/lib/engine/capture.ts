import type { ByTwin, TwinSnapshot, TwinAuditRow, TwinName } from "@sonata/core";

export interface Capture {
  before: ByTwin<TwinSnapshot>;
  after: ByTwin<TwinSnapshot>;
  audit: TwinAuditRow[];
  /** Per twin, why the above is short. Travels into the artifact verbatim. */
  notes: Partial<Record<TwinName, string>>;
}

export function explainUnpaired(capture: Capture, twins: readonly TwinName[]): void {
  for (const twin of twins) {
    if (capture.notes[twin]) continue;
    if (capture.before[twin] && capture.after[twin]) continue;
    capture.notes[twin] = capture.before[twin]
      ? `the ${twin} clone gave no closing snapshot, so the opening one has nothing to be diffed against`
      : `the day ended before an opening snapshot of ${twin} was taken, so there is nothing to diff the closing one against`;
  }
}

