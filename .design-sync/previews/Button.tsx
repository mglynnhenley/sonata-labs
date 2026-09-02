import { Button, IconArrowRight, IconPlay, IconCopy } from "@sonata/ui";

/** The four variants, side by side — petrol primary is rationed to one per view. */
export const Variants = () => (
  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
    <Button variant="primary">Start the day</Button>
    <Button variant="secondary">Smoke test</Button>
    <Button variant="ghost">Cancel</Button>
    <Button variant="danger">Stop the day</Button>
  </div>
);

export const Sizes = () => (
  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
    <Button variant="primary" size="sm">
      Run
    </Button>
    <Button variant="primary" size="md">
      New run
    </Button>
    <Button variant="primary" size="lg">
      Clone a company
    </Button>
  </div>
);

export const WithIcons = () => (
  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
    <Button variant="primary" icon={<IconPlay size="sm" />}>
      Watch the day
    </Button>
    <Button variant="secondary" iconRight={<IconArrowRight size="sm" />}>
      See the results
    </Button>
    <Button variant="secondary" icon={<IconCopy size="sm" />} iconOnly aria-label="Copy run id" />
  </div>
);

export const States = () => (
  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
    <Button variant="primary" loading>
      Starting…
    </Button>
    <Button variant="primary" disabled>
      Start the day
    </Button>
    <Button variant="secondary" disabled>
      Unpriced
    </Button>
  </div>
);
