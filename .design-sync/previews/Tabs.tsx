import { TabPanel, Tabs } from "@sonata/ui";

const ITEMS = [
  { id: "general", label: "General" },
  { id: "autonomy", label: "Autonomy" },
  { id: "cost", label: "Cost" },
  { id: "activity", label: "Activity", count: 12 },
] as const;

/** Underline variant with the selected panel showing beneath. */
export const Underline = () => (
  <div style={{ width: 520 }}>
    <Tabs
      items={ITEMS}
      value="autonomy"
      onValueChange={() => {}}
      idPrefix="tabs-underline"
      label="Run sections"
    />
    <TabPanel id="autonomy" active idPrefix="tabs-underline">
      <p style={{ margin: "14px 0 0", fontSize: 13.5, color: "#5A6060", lineHeight: "20px" }}>
        Autonomy is the share of the workday the clone finished without a human
        stepping in.
      </p>
    </TabPanel>
  </div>
);

/** Pill variant — the segmented look for filters above tables. */
export const Pill = () => (
  <div style={{ width: 520, display: "flex" }}>
    <Tabs
      variant="pill"
      items={ITEMS}
      value="general"
      onValueChange={() => {}}
      idPrefix="tabs-pill"
      label="Run sections"
    />
  </div>
);
