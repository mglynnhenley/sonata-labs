import { ProgressBar } from "@sonata/ui";

/** The run view's clock: label left, honest count right. */
export const DayProgress = () => (
  <div style={{ maxWidth: 420 }}>
    <ProgressBar label="Simulated day" value={34} max={96} showValue valueLabel="tick 34 / 96" />
  </div>
);

/** The four tones — petrol for progress, state hues only where they mean something. */
export const Tones = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 420 }}>
    <ProgressBar label="Day progress" value={62} showValue tone="primary" />
    <ProgressBar label="Budget used" value={31} showValue valueLabel="$0.12 of $0.40" tone="gold" />
    <ProgressBar label="Criteria passed" value={12} max={14} showValue valueLabel="12 / 14" tone="success" />
    <ProgressBar label="Criteria failed" value={2} max={14} showValue valueLabel="2 / 14" tone="danger" />
  </div>
);

/** `sm` for table rows and tight card footers. */
export const Sizes = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 420 }}>
    <ProgressBar label="md" value={76} size="md" showValue />
    <ProgressBar label="sm" value={76} size="sm" showValue />
  </div>
);

/** No known length yet — the tick loop before the day is planned. */
export const Indeterminate = () => (
  <div style={{ maxWidth: 420 }}>
    <ProgressBar label="Planning the day…" value={0} indeterminate />
  </div>
);
