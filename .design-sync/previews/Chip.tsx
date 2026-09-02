import { Chip, IconSpark } from "@sonata/ui";

/** The three twins a scenario touches — service sets label, icon and hue in one prop. */
export const Services = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <Chip service="gmail" />
    <Chip service="slack" />
    <Chip service="calendar" />
  </div>
);

/** Neutral for plain tags, gold for the special one. */
export const Tones = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <Chip tone="neutral" icon={false}>
      Smoke test
    </Chip>
    <Chip tone="neutral" icon={false}>
      21 scenarios
    </Chip>
    <Chip tone="gold" icon={<IconSpark size="sm" />}>
      Golden run
    </Chip>
  </div>
);

/** Custom copy on a service hue — where the agent actually worked. */
export const ServiceCounts = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <Chip service="gmail">Gmail · 12 threads</Chip>
    <Chip service="slack">Slack · #client-fires</Chip>
    <Chip service="calendar">Calendar · 3 invites</Chip>
  </div>
);

/** With onClick the chip becomes a filter toggle; unselected reads as "off". */
export const FilterRow = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <Chip service="gmail" onClick={() => {}} selected={true} />
    <Chip service="slack" onClick={() => {}} selected={false} />
    <Chip service="calendar" onClick={() => {}} selected={false} />
  </div>
);

/** `sm` for table cells and timeline meta. */
export const Sizes = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <Chip service="gmail" size="sm" />
    <Chip service="gmail" size="md" />
    <Chip tone="neutral" icon={false} size="sm">
      Claude Haiku 4.5
    </Chip>
  </div>
);
