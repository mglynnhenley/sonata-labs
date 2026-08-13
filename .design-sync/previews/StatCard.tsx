import { StatCard, IconSpark, IconPlay, IconLayers } from "@sonata/ui";

/** A dashboard row: label, big value, honest footnote. */
export const Row = () => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
    <StatCard
      label="Autonomy"
      value="76%"
      icon={<IconSpark size="md" />}
      hint="Mean across 21 scored runs — mixes scenarios and models"
    />
    <StatCard label="Runs" value="44" icon={<IconPlay size="sm" />} hint="21 companies · 21 scenarios" />
    <StatCard label="Spend" value="$12.06" icon={<IconLayers size="md" />} hint="Every model call so far" />
  </div>
);

/** One unusually long footnote must not set the height of the row — it clamps
 *  to two lines from `sm` and the full text stays reachable. */
export const LongHint = () => (
  <div style={{ maxWidth: 280 }}>
    <StatCard
      label="Autonomy"
      value="77%"
      icon={<IconSpark size="md" />}
      hint="Mean across 21 scored runs — mixes scenarios and models · 8 were simulated, no model was ever called, so they are not counted · 15 more never ran, so they are not counted"
    />
  </div>
);

export const AsLink = () => (
  <div style={{ maxWidth: 280 }}>
    <StatCard
      label="Runs passed"
      value="2 of 21"
      href="#"
      actionLabel="Which criteria failed"
      hint="Finished runs where every criterion the day could decide passed."
    />
  </div>
);

export const Loading = () => (
  <div style={{ maxWidth: 280 }}>
    <StatCard label="Autonomy" value="—" loading hint="Waiting for the first scored run." />
  </div>
);
