import { Badge } from "@sonata/ui";

/** The six run states. `running` breathes — live is the loudest thing on any page. */
export const Statuses = () => (
  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
    <Badge status="running" />
    <Badge status="passed" />
    <Badge status="failed" />
    <Badge status="pending" />
    <Badge status="warning" />
    <Badge status="neutral" />
  </div>
);

/** `sm` sits inside table rows; `md` everywhere else. */
export const Sizes = () => (
  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
    <Badge status="passed" size="sm" />
    <Badge status="passed" size="md" />
    <Badge status="running" size="sm" />
    <Badge status="running" size="md" />
  </div>
);

/** Custom copy over a status hue — counts and verdicts, not just the label. */
export const CustomLabels = () => (
  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
    <Badge status="failed">2 criteria failed</Badge>
    <Badge status="passed">14 / 14 passed</Badge>
    <Badge status="running">Tick 34 of 96</Badge>
    <Badge status="warning">Calendar out of sync</Badge>
  </div>
);

/** Dotless — for dense meta rows where six dots would read as a rash. */
export const NoDot = () => (
  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
    <Badge status="neutral" dot={false}>
      Claude Haiku 4.5
    </Badge>
    <Badge status="neutral" dot={false}>
      $0.40 per day
    </Badge>
    <Badge status="pending" dot={false}>
      Queued
    </Badge>
  </div>
);
