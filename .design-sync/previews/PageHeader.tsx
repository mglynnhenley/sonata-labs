import { Badge, Button, Chip, PageHeader } from "@sonata/ui";

export const Overview = () => (
  <div style={{ width: 760 }}>
    <PageHeader
      eyebrow="Overview"
      title="What's happening"
      subtitle="Autonomy is the share of the workday the clone finished without a human stepping in."
      actions={<Button variant="primary">New run</Button>}
    />
  </div>
);

/** Meta row: which twins the scenario touches, plus the live state. */
export const WithMeta = () => (
  <div style={{ width: 760 }}>
    <PageHeader
      eyebrow="Scenario"
      title="Quarterly close at Axiom Health"
      subtitle="Claude Haiku 4.5 works the books through a simulated Tuesday."
      actions={
        <>
          <Button variant="secondary">Edit scenario</Button>
          <Button variant="primary">Start the day</Button>
        </>
      }
      meta={
        <>
          <Chip service="gmail" size="sm" />
          <Chip service="slack" size="sm" />
          <Chip service="calendar" size="sm" />
          <Badge status="running" size="sm">
            2 live runs
          </Badge>
        </>
      }
      border
    />
  </div>
);
