import { Badge, Button, Card, Chip } from "@sonata/ui";

/** The full anatomy: header row, body, hairline footer. */
export const Canonical = () => (
  <div style={{ maxWidth: 460 }}>
    <Card
      title="The Final Loop"
      subtitle="A client threatens to churn while the standup moves twice."
      actions={<Badge status="running" />}
      footer={
        <>
          <span>Claude Haiku 4.5</span>
          <span>·</span>
          <span>$0.40 per day</span>
        </>
      }
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Chip service="gmail" size="sm" />
        <Chip service="slack" size="sm" />
        <Chip service="calendar" size="sm" />
      </div>
    </Card>
  </div>
);

/** Surface carries content, sunken recedes, outline barely registers. */
export const Tones = () => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
    <Card tone="surface" title="Surface" subtitle="Runs, results, evidence." />
    <Card tone="sunken" title="Sunken" subtitle="Wells inside other cards." />
    <Card tone="outline" title="Outline" subtitle="Grouping without weight." />
  </div>
);

/** Padding steps — sm for dense grids, lg for the hero panel. */
export const Paddings = () => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
    <Card padding="sm" title="sm" subtitle="Autonomy 76%" />
    <Card padding="md" title="md" subtitle="Autonomy 76%" />
    <Card padding="lg" title="lg" subtitle="Autonomy 76%" />
  </div>
);

/** Hover lift for cards that link somewhere — the whole card is the target. */
export const Interactive = () => (
  <div style={{ maxWidth: 380 }}>
    <Card
      interactive
      title="Replied to Dr. Kapoor"
      subtitle="Criterion passed — the reply landed before the 11:00 deadline."
      actions={<Badge status="passed" size="sm" />}
    />
  </div>
);

/** padding="none" — the header and footer pad themselves; the body goes edge to edge. */
export const EdgeToEdge = () => (
  <div style={{ maxWidth: 460 }}>
    <Card
      padding="none"
      title="Run r-0418"
      subtitle="Scenario: The Final Loop"
      actions={<Button variant="secondary" size="sm">View run</Button>}
      footer={<span>Finished in 96 ticks · simulated Tuesday</span>}
    >
      <div
        style={{
          height: 72,
          display: "grid",
          placeItems: "center",
          background: "#F1EFE9",
          fontSize: 12,
          color: "#5A6060",
        }}
      >
        chart area — edge to edge
      </div>
    </Card>
  </div>
);
