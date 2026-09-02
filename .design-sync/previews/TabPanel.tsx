import { TabPanel, Tabs } from "@sonata/ui";

const ITEMS = [
  { id: "general", label: "General" },
  { id: "autonomy", label: "Autonomy" },
  { id: "cost", label: "Cost" },
  { id: "activity", label: "Activity" },
] as const;

/** TabPanel only means anything inside a Tabs composition — shown selected. */
export const WithinTabs = () => (
  <div style={{ width: 520 }}>
    <Tabs
      items={ITEMS}
      value="cost"
      onValueChange={() => {}}
      idPrefix="panel-demo"
      label="Run sections"
    />
    <TabPanel id="cost" active idPrefix="panel-demo">
      <p style={{ margin: "14px 0 0", fontSize: 13.5, color: "#5A6060", lineHeight: "20px" }}>
        This run cost $0.42 across 96 Claude Haiku 4.5 calls — Gmail was the
        busiest surface, Calendar the quietest.
      </p>
    </TabPanel>
  </div>
);
